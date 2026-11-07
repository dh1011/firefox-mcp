/** What the daemon asks of a tab: navigating, content-script operations across frames, snapshots and screenshots */
import type {
  ActionOutcome,
  AriaNode,
  BrowserMethods,
  LocatorCall,
  Metrics,
  Target,
} from "../../protocol";
import type { OpResult } from "../content/index";
import { isExposedUrl, refusedUrlMessage } from "./rules";
import {
  exposedTab,
  isTransientError,
  sendToFrame,
  stateOf,
  type TabState,
} from "./tabs";

/** How long after an action a navigation may start and still be waited for */
const NAVIGATION_START_MS = 300;
const NAVIGATION_LOAD_MS = 10_000;
const DEFAULT_OP_TIMEOUT_MS = 5000;
/** How long a page gets to answer one message, unless the operation itself may take longer */
const MIN_MESSAGE_TIMEOUT_MS = 8000;
/** Operations with no target that go where the keyboard's focus is */
const KEYBOARD_OPS = new Set(["type", "press"]);
/** Operations that move the keyboard's focus to their target's frame */
const FOCUS_OPS = new Set(["click", "fill"]);
/**
 * Operations that hand the page what the agent gives them. Unless a ref or `frameLocator` points into an iframe, they stay
 * in the page itself: searching every frame lets an ad's or a widget's iframe take a password while the page's own field
 * is still loading
 */
const PAGE_ONLY_OPS = new Set(["fill", "upload"]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForLoad(state: TabState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (state.loading && Date.now() < deadline) await sleep(25);
  return !state.loading;
}

/** Runs an action and waits for a navigation it started, so the next step sees the new page */
async function settled(state: TabState, action: () => Promise<unknown>): Promise<ActionOutcome> {
  const epoch = state.navEpoch;
  let value: unknown;
  try {
    value = await action();
  } catch (error) {
    // The action took the page with it: that's the navigation it was for
    if (state.navEpoch === epoch || !isTransientError(error)) throw error;
  }
  const startBy = Date.now() + NAVIGATION_START_MS;
  while (state.navEpoch === epoch && Date.now() < startBy) await sleep(25);
  let stillLoading = false;
  if (state.navEpoch !== epoch) {
    stillLoading = !(await waitForLoad(state, NAVIGATION_LOAD_MS));
  }
  return { ...(await drained(state)), value, ...(stillLoading ? { stillLoading } : {}) };
}

/** What the page did since the last call: the tabs it opened and the dialogs it showed */
async function drained(state: TabState): Promise<ActionOutcome> {
  const opened = state.opened.splice(0);
  const dialogs = state.dialogs.splice(0);
  const navError = state.navError;
  state.navError = null;
  let url: string | undefined;
  let title: string | undefined;
  try {
    const tab = await browser.tabs.get(state.tabId);
    url = tab.url;
    title = tab.title;
  } catch {
    // The tab closed
  }
  return {
    ...(url !== undefined ? { url } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(opened.length ? { opened } : {}),
    ...(dialogs.length ? { dialogs } : {}),
    ...(navError ? { navError } : {}),
    errorCount: state.errorCount,
    ...(state.lastError !== undefined ? { lastError: state.lastError } : {}),
  };
}

// --- Targets ---

const REF = /^(f\d+)?(e\d+)$/;

/** Splits locator calls at frame boundaries: every part but the last finds an iframe */
function splitAtFrames(calls: LocatorCall[]): LocatorCall[][] {
  const parts: LocatorCall[][] = [];
  let current: LocatorCall[] = [];
  for (const call of calls) {
    if (call.method === "frameLocator") {
      current.push({ method: "locator", args: call.args });
      parts.push(current);
      current = [];
    } else if (call.method === "contentFrame") {
      parts.push(current);
      current = [];
    } else {
      current.push(call);
    }
  }
  parts.push(current);
  return parts;
}

type Placed = { frames: number[]; wire: Target & { doc?: string } } | { error: string } | null;

/** Where to run a target: a ref's frame, a locator's iframe, or every frame, the main one first (or only it) */
async function place(state: TabState, target: Target, everyFrame = true): Promise<Placed> {
  if (target.kind === "ref") {
    const match = REF.exec(target.ref);
    const alias = match?.[1] ?? "";
    const known = state.refDocs.get(alias);
    if (!match || !known) {
      return {
        error: `Ref ${target.ref} isn't on the page anymore. Run \`snapshot -i\` or use a locator`,
      };
    }
    return {
      frames: [known.frameId],
      wire: { ...target, ref: match[2]!, doc: known.doc },
    };
  }
  if (target.kind === "locator") {
    const parts = splitAtFrames(target.calls);
    if (parts.length > 1) {
      let frameId = 0;
      for (const calls of parts.slice(0, -1)) {
        const reply = await sendToFrame<OpResult>(state.tabId, frameId, {
          op: "frameOf",
          target: { kind: "locator", calls, source: target.source },
        });
        if ("error" in reply) return { error: reply.error };
        if (!("ok" in reply)) return null;
        frameId = (reply.value as { frameId: number }).frameId;
      }
      return {
        frames: [frameId],
        wire: { ...target, calls: parts.at(-1)! },
      };
    }
  }
  if (!everyFrame) return { frames: [0], wire: target };
  const frames = (await browser.webNavigation.getAllFrames({ tabId: state.tabId })) ?? [];
  const ids = frames.map((frame) => frame.frameId).sort((a, b) => a - b);
  return { frames: ids.length ? ids : [0], wire: target };
}

function nothingMatches(target: Target, op: string) {
  const text = `Nothing matches ${target.source}. Run \`find "<text>"\` or \`snapshot -i\` to see what's on the page`;
  if (!PAGE_ONLY_OPS.has(op) || target.kind === "ref") return text;
  if (target.kind === "locator" && target.calls.some((call) => call.method === "frameLocator" || call.method === "contentFrame")) {
    return text;
  }
  return `${text}. ${op} looks only in the page itself, not in its iframes: for a field in an iframe, use its ref from \`snapshot -i\` or \`frameLocator('<iframe>')\``;
}

/** Runs an operation on its target, polling until it can happen or time runs out */
async function runOp(
  state: TabState,
  op: string,
  target: Target | undefined,
  args: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<{ value: unknown; frameId: number }> {
  const deadline = Date.now() + timeoutMs;
  let lastRetry: string | undefined;
  let lastTransient: unknown;
  for (;;) {
    try {
      const placed = target
        ? await place(state, target, !PAGE_ONLY_OPS.has(op))
        : { frames: [KEYBOARD_OPS.has(op) ? state.focusFrame : 0], wire: undefined };
      if (placed && "error" in placed) throw new Error(placed.error);
      if (placed) {
        for (const frameId of placed.frames) {
          let reply: OpResult;
          try {
            reply = await sendToFrame<OpResult>(
              state.tabId,
              frameId,
              { op, target: placed.wire, args },
              Math.max(MIN_MESSAGE_TIMEOUT_MS, timeoutMs),
            );
          } catch (error) {
            // A child frame that can't run the script doesn't stop the search of the others
            if (frameId !== 0 && placed.frames.length > 1) continue;
            // The frame with focus went away, so focus is back in the page
            if (!target && frameId === state.focusFrame) state.focusFrame = 0;
            throw error;
          }
          if ("ok" in reply) {
            if (FOCUS_OPS.has(op)) state.focusFrame = frameId;
            return { value: reply.value, frameId };
          }
          if ("error" in reply) throw new Error(reply.error);
          if ("retry" in reply) lastRetry = reply.retry;
        }
      }
      lastTransient = undefined;
    } catch (error) {
      if (!isTransientError(error)) throw error;
      lastTransient = error;
    }
    if (Date.now() >= deadline) {
      if (lastRetry) throw new Error(lastRetry);
      if (target) throw new Error(nothingMatches(target, op));
      throw lastTransient instanceof Error ? lastTransient : new Error("The page didn't answer in time");
    }
    await sleep(100);
  }
}

// --- Snapshots ---

function prefixRefs(nodes: AriaNode[], alias: string) {
  for (const node of nodes) {
    if (node.ref) node.ref = `${alias}${node.ref}`;
    if (node.children) prefixRefs(node.children, alias);
  }
}

function aliasFor(state: TabState, frameId: number): string {
  let alias = state.frameAliases.get(frameId);
  if (!alias) {
    alias = `f${state.nextFrameAlias++}`;
    state.frameAliases.set(frameId, alias);
  }
  return alias;
}

async function frameTree(state: TabState, frameId: number, depth: number): Promise<AriaNode[]> {
  const reply = await sendToFrame<OpResult>(state.tabId, frameId, { op: "snapshot" }, frameId === 0 ? 8000 : 3000);
  if (!("ok" in reply)) {
    throw new Error("error" in reply ? reply.error : "The frame has no snapshot");
  }
  const { nodes, doc, truncated } = reply.value as { nodes: AriaNode[]; doc: string; truncated: boolean };
  const alias = frameId === 0 ? "" : aliasFor(state, frameId);
  state.refDocs.set(alias, { frameId, doc });
  if (alias) prefixRefs(nodes, alias);
  await graftFrames(state, nodes, depth);
  if (truncated) nodes.push({ role: "text", text: "… this page is very large, so its snapshot stops here. Use a target to look at a part of it" });
  return nodes;
}

async function graftFrames(state: TabState, nodes: AriaNode[], depth: number): Promise<void> {
  const work: Promise<void>[] = [];
  const walk = (list: AriaNode[]) => {
    for (const node of list) {
      if (node.frameId !== undefined) {
        const frameId = node.frameId;
        delete node.frameId;
        if (depth >= 5) continue;
        work.push(
          frameTree(state, frameId, depth + 1).then(
            (children) => {
              if (children.length) node.children = children;
            },
            () => {
              node.children = [{ role: "text", text: "(this frame didn't answer)" }];
            },
          ),
        );
      } else if (node.children) {
        walk(node.children);
      }
    }
  };
  walk(nodes);
  await Promise.all(work);
}

async function snapshot(state: TabState): Promise<AriaNode[]> {
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      return await frameTree(state, 0, 0);
    } catch (error) {
      if (!isTransientError(error) || Date.now() >= deadline) throw error;
      await sleep(100);
    }
  }
}

// --- Screenshots ---

const MAX_FULL_PAGE_HEIGHT = 16_384;

type Box = { x: number; y: number; width: number; height: number; scrollX: number; scrollY: number };

/** Places a box in a child frame in the coordinates of the top document */
async function toTopDocument(state: TabState, frameId: number, box: Box): Promise<Box> {
  if (frameId === 0) return box;
  const frames = (await browser.webNavigation.getAllFrames({ tabId: state.tabId })) ?? [];
  const parents = new Map(frames.map((frame) => [frame.frameId, frame.parentFrameId]));
  let x = box.x - box.scrollX;
  let y = box.y - box.scrollY;
  let child = frameId;
  for (;;) {
    const parent = parents.get(child);
    if (parent === undefined || parent < 0) break;
    const reply = await sendToFrame<OpResult>(state.tabId, parent, {
      op: "frameOffset",
      args: { frameId: child },
    });
    if (!("ok" in reply)) throw new Error("Couldn't place the iframe in the page");
    const offset = reply.value as { x: number; y: number };
    x += offset.x;
    y += offset.y;
    if (parent !== 0) {
      const metrics = (await sendToFrame<OpResult>(state.tabId, parent, { op: "metrics" })) as { ok: true; value: Metrics };
      x -= metrics.value.scrollX;
      y -= metrics.value.scrollY;
    }
    child = parent;
  }
  return { ...box, x, y };
}

async function screenshot(
  state: TabState,
  params: BrowserMethods["page.screenshot"]["params"],
): Promise<BrowserMethods["page.screenshot"]["result"]> {
  const { value: metricsValue } = await runOp(state, "metrics", undefined, undefined, DEFAULT_OP_TIMEOUT_MS);
  const metrics = metricsValue as Metrics;
  let rect = {
    x: metrics.scrollX,
    y: metrics.scrollY,
    width: metrics.width,
    height: metrics.height,
  };
  if (params.request.kind === "full") {
    rect = {
      x: 0,
      y: 0,
      width: metrics.scrollWidth,
      height: Math.min(metrics.scrollHeight, MAX_FULL_PAGE_HEIGHT),
    };
  } else if (params.request.kind === "element") {
    const { value, frameId } = await runOp(state, "box", params.request.target, undefined, DEFAULT_OP_TIMEOUT_MS);
    const placed = await toTopDocument(state, frameId, value as Box);
    rect = { x: placed.x, y: placed.y, width: placed.width, height: placed.height };
  }
  if (rect.width <= 0 || rect.height <= 0) throw new Error("There's nothing to capture: the area has no size");
  const longest = Math.max(rect.width, rect.height);
  const scale = Math.min(metrics.dpr, params.maxSide / longest);
  const dataUrl = await (browser.tabs as unknown as {
    captureTab(tabId: number, options: Record<string, unknown>): Promise<string>;
  }).captureTab(state.tabId, { format: "jpeg", quality: 80, rect, scale });
  return {
    dataUrl,
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  };
}

// --- The methods ---

export async function navigate(params: BrowserMethods["page.navigate"]["params"]): Promise<ActionOutcome> {
  const { tabId, kind, url } = params;
  const state = stateOf(tabId);
  if (kind === "goto") {
    if (!url || !isExposedUrl(url)) throw new Error(refusedUrlMessage(url ?? ""));
  } else {
    await exposedTab(tabId);
  }
  const epoch = state.navEpoch;
  state.navError = null;
  if (kind === "goto") {
    // Set here, as `onBeforeNavigate` comes a moment later
    state.navEpoch++;
    state.loading = true;
    state.committed = false;
    state.supersededUrl = state.navUrl ?? state.supersededUrl;
    state.navUrl = null;
    state.gotoPending = url !== "about:blank";
    await browser.tabs.update(tabId, { url });
  } else if (kind === "back") {
    await browser.tabs.goBack(tabId);
  } else if (kind === "forward") {
    await browser.tabs.goForward(tabId);
  } else {
    state.navEpoch++;
    state.loading = true;
    state.committed = false;
    await browser.tabs.reload(tabId);
  }
  if (kind === "back" || kind === "forward") {
    const startBy = Date.now() + 1000;
    while (state.navEpoch === epoch && Date.now() < startBy) await sleep(25);
    if (state.navEpoch === epoch) throw new Error(`There's no page to go ${kind} to`);
  }
  const loaded = await waitForLoad(state, kind === "goto" ? 30_000 : NAVIGATION_LOAD_MS);
  if (state.navError) {
    throw new Error(`Couldn't load the page: ${state.navError}`);
  }
  return { ...(await drained(state)), ...(loaded ? {} : { stillLoading: true }) };
}

export async function pageOp(params: BrowserMethods["page.op"]["params"]): Promise<ActionOutcome> {
  const { tabId, op, target, args, timeoutMs, settle } = params;
  const state = stateOf(tabId);
  await exposedTab(tabId);
  const timeout = timeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
  if (!settle) {
    const { value, frameId } = await runOp(state, op, target, args, timeout);
    // The ref of an element in an iframe has its frame's prefix, like the snapshot's
    if (op === "ref" && frameId !== 0) {
      const { ref } = value as { ref: string };
      return { value: { ref: `${aliasFor(state, frameId)}${ref}` } };
    }
    return { value };
  }
  return settled(state, async () => (await runOp(state, op, target, args, timeout)).value);
}

export async function pageCount(params: BrowserMethods["page.count"]["params"]): Promise<{ count: number }> {
  const state = stateOf(params.tabId);
  await exposedTab(params.tabId);
  const placed = await place(state, params.target);
  if (!placed) return { count: 0 };
  if ("error" in placed) throw new Error(placed.error);
  let count = 0;
  for (const frameId of placed.frames) {
    try {
      const reply = await sendToFrame<OpResult>(state.tabId, frameId, {
        op: "count",
        target: placed.wire,
        args: { visibleOnly: params.visibleOnly },
      });
      if ("ok" in reply) count += reply.value as number;
      else if ("error" in reply) throw new Error(reply.error);
    } catch (error) {
      if (!isTransientError(error) && frameId === 0) throw error;
    }
  }
  return { count };
}

export async function pageSnapshot(params: BrowserMethods["page.snapshot"]["params"]) {
  const state = stateOf(params.tabId);
  await exposedTab(params.tabId);
  return { nodes: await snapshot(state) };
}

export async function pageScreenshot(params: BrowserMethods["page.screenshot"]["params"]) {
  const state = stateOf(params.tabId);
  await exposedTab(params.tabId);
  return screenshot(state, params);
}

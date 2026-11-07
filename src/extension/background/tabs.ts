/**
 * Claimed tabs: what the extension does for tabs agents drive. Nothing happens in any other tab: no scripts, no request
 * listeners.
 */
import type {
  AppInfo,
  ConsoleEntry,
  DialogEntry,
  RequestEntry,
  TabInfo,
} from "../../protocol";
import { isExposedUrl, refusedUrlMessage, safeHeaders, safePostData, safeUrl } from "./rules";

const MAX_LOG = 500;
const BODY_LIMIT = 1_000_000;
const BODIES_TOTAL_LIMIT = 16_000_000;
/** Responses worth keeping for `request --body`: what a page fetched and its documents, as text */
const BODY_RESOURCE_TYPES = new Set(["xmlhttprequest", "main_frame", "sub_frame"]);
const TEXT_TYPE = /text\/(?!event-stream)|json|xml|javascript|csv|urlencoded/i;
const NO_BODY_STATUS = new Set([204, 205, 301, 302, 303, 307, 308]);
/** Past this, a document held for the hooks goes on without them, rather than stall if it never commits */
const HOLD_LIMIT_MS = 1500;

export type DialogPolicy = { accept: boolean; text?: string };

export type TabState = {
  tabId: number;
  app: AppInfo;
  /** Counts navigations of the main frame, so an action can tell if it started one */
  navEpoch: number;
  loading: boolean;
  committed: boolean;
  /** Where the latest navigation of the main frame is going, once Firefox has said */
  navUrl: string | null;
  /** Where the navigation before it was going: its error page can show up late */
  supersededUrl: string | null;
  /** A `goto` that Firefox hasn't started yet */
  gotoPending: boolean;
  /** The frame an agent last clicked or filled in, where keys go */
  focusFrame: number;
  navError: string | null;
  /** For each frame: lets through the document held back until the hooks are in */
  gates: Map<number, () => void>;
  frameAliases: Map<number, string>;
  nextFrameAlias: number;
  /** For each frame alias (`""` for the main frame): the document its refs belong to */
  refDocs: Map<string, { frameId: number; doc: string }>;
  policy: DialogPolicy | null;
  console: ConsoleEntry[];
  consoleSeq: number;
  errorCount: number;
  lastError: string | undefined;
  requests: RequestEntry[];
  requestSeq: number;
  requestsById: Map<string, RequestEntry>;
  bodyBytes: number;
  dialogs: DialogEntry[];
  opened: { tabId: number; url: string }[];
  stopTracking: () => void;
};

export const claimed = new Map<number, TabState>();

export function stateOf(tabId: number): TabState {
  const state = claimed.get(tabId);
  if (!state) {
    throw new Error(`Tab ${tabId} isn't in use. Run \`tab list\` and \`tab select <id>\``);
  }
  return state;
}

export function toTabInfo(tab: browser.tabs.Tab): TabInfo {
  return {
    tabId: tab.id!,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: !!tab.active,
    pinned: !!tab.pinned,
    windowId: tab.windowId!,
    loading: tab.status === "loading",
  };
}

export async function exposedTab(tabId: number): Promise<browser.tabs.Tab> {
  let tab: browser.tabs.Tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    throw new Error(`There's no tab ${tabId}. Run \`tab list\``);
  }
  if (!isExposedUrl(tab.url)) throw new Error(refusedUrlMessage(tab.url ?? "this page"));
  return tab;
}

// --- Tab groups ---

const GROUP_COLORS = ["blue", "purple", "cyan", "orange", "green", "pink", "yellow", "red"] as const;

/** A group for each app in each window */
const groups = new Map<string, number>();

function colorFor(appId: string) {
  let hash = 0;
  for (const char of appId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return GROUP_COLORS[Math.abs(hash) % GROUP_COLORS.length]!;
}

/** Shows whose tab it is. Only cosmetic, so failing doesn't stop anything */
export async function groupTab(tabId: number, app: AppInfo) {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.pinned) return;
    const key = `${app.id}:${tab.windowId}`;
    let groupId = groups.get(key);
    const tabs = browser.tabs as unknown as {
      group(options: {
        tabIds: number[];
        groupId?: number;
        createProperties?: { windowId?: number };
      }): Promise<number>;
    };
    const tabGroups = (browser as unknown as {
      tabGroups: {
        update(id: number, props: { title?: string; color?: string }): Promise<unknown>;
        query(info: { title?: string; windowId?: number }): Promise<{ id: number }[]>;
      };
    }).tabGroups;
    if (groupId === undefined) {
      const [existing] = await tabGroups.query({ title: app.name, windowId: tab.windowId });
      groupId = existing?.id;
    }
    if (groupId !== undefined) {
      try {
        await tabs.group({ tabIds: [tabId], groupId });
        groups.set(key, groupId);
        return;
      } catch {
        groups.delete(key);
      }
    }
    groupId = await tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    groups.set(key, groupId);
    await tabGroups.update(groupId, { title: app.name, color: colorFor(app.id) });
  } catch (error) {
    console.debug("firefox-mcp: couldn't group the tab", error);
  }
}

// --- Scripts ---

const NOT_LISTENING = /Receiving end does not exist|Could not establish connection/i;

export class PageUnavailable extends Error {}

/** Loads the content script into a frame, at the start of its document if it just committed */
export async function inject(tabId: number, frameId: number) {
  await browser.tabs.executeScript(tabId, {
    file: "/content.js",
    frameId,
    runAt: "document_start",
    matchAboutBlank: true,
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PageUnavailable(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const STUCK_MESSAGE =
  "The page isn't responding: it may be busy, or showing a dialog that opened before the extension could answer it. Ask the user to look at the tab";

/** Sends an operation to a frame's content script, loading the script first if it isn't there */
export async function sendToFrame<T>(
  tabId: number,
  frameId: number,
  message: unknown,
  timeoutMs = 8000,
): Promise<T> {
  const send = () =>
    withTimeout(
      browser.tabs.sendMessage(tabId, message, { frameId }) as Promise<T | undefined>,
      timeoutMs,
      STUCK_MESSAGE,
    );
  let reply: T | undefined;
  try {
    reply = await send();
  } catch (error) {
    if (error instanceof PageUnavailable || !NOT_LISTENING.test(String(error))) throw error;
    try {
      await inject(tabId, frameId);
    } catch (injectError) {
      // Between documents, a frame refuses scripts for a moment
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (tab?.status === "loading") throw new Error("The page is navigating");
      throw new PageUnavailable(
        `Firefox doesn't let extensions run on this page (${String((injectError as Error).message ?? injectError)})`,
      );
    }
    reply = await send();
  }
  if (reply === undefined) throw new Error("Receiving end does not exist");
  return reply;
}

/** A message that means the page went away under the call: it's worth trying again on the page that replaced it */
export function isTransientError(error: unknown): boolean {
  if (error instanceof PageUnavailable) return false;
  return /Receiving end|establish connection|Message manager|message channel|Actor|destroyed|BrowsingContext|navigat|No matching message handler/i.test(
    String((error as Error)?.message ?? error),
  );
}

// --- Requests ---

function trackRequests(state: TabState): () => void {
  const { tabId } = state;
  const filter: browser.webRequest.RequestFilter = { urls: ["<all_urls>"], tabId };
  const onBefore = (details: { requestId: string; method: string; url: string; type: string; requestBody?: unknown }) => {
    const postData = safePostData(details.requestBody, BODY_LIMIT);
    const entry: RequestEntry = {
      id: ++state.requestSeq,
      method: details.method,
      url: safeUrl(details.url),
      type: details.type,
      status: null,
      ...(postData ? { postData } : {}),
    };
    state.requests.push(entry);
    state.requestsById.set(details.requestId, entry);
    if (state.requests.length > MAX_LOG) {
      const dropped = state.requests.shift();
      if (dropped?.body) state.bodyBytes -= dropped.body.length;
    }
  };
  const onSend = (details: { requestId: string; requestHeaders?: { name: string; value?: string }[] }) => {
    const entry = state.requestsById.get(details.requestId);
    if (entry) entry.requestHeaders = safeHeaders(details.requestHeaders);
  };
  const onHeaders = (details: {
    requestId: string;
    frameId: number;
    type: string;
    statusCode: number;
    statusLine: string;
    responseHeaders?: { name: string; value?: string }[];
  }) => {
    const entry = state.requestsById.get(details.requestId);
    if (!entry) return;
    entry.status = details.statusCode;
    entry.statusLine = details.statusLine;
    entry.responseHeaders = safeHeaders(details.responseHeaders);
    if (BODY_RESOURCE_TYPES.has(details.type) && !NO_BODY_STATUS.has(details.statusCode)) {
      captureBody(state, entry, details);
    }
  };
  const onDone = (details: { requestId: string; statusCode?: number; type?: string; frameId?: number }) => {
    const entry = state.requestsById.get(details.requestId);
    if (entry && details.statusCode) entry.status = details.statusCode;
    state.requestsById.delete(details.requestId);
    // A document commits long before its request ends, so if this one hasn't, it isn't going to
    if (details.type === "main_frame" && !state.committed && state.loading) endNavigationSoon(state);
  };
  const onError = (details: { requestId: string; error: string }) => {
    const entry = state.requestsById.get(details.requestId);
    if (entry) entry.failure = details.error;
    state.requestsById.delete(details.requestId);
  };
  const webRequest = browser.webRequest;
  webRequest.onBeforeRequest.addListener(onBefore as never, filter, ["requestBody"]);
  webRequest.onSendHeaders.addListener(onSend as never, filter, ["requestHeaders"]);
  // Blocking only so the response can be read as it passes: it answers at once
  webRequest.onHeadersReceived.addListener(onHeaders as never, filter, ["blocking", "responseHeaders"]);
  webRequest.onCompleted.addListener(onDone as never, filter);
  webRequest.onErrorOccurred.addListener(onError as never, filter);
  return () => {
    webRequest.onBeforeRequest.removeListener(onBefore as never);
    webRequest.onSendHeaders.removeListener(onSend as never);
    webRequest.onHeadersReceived.removeListener(onHeaders as never);
    webRequest.onCompleted.removeListener(onDone as never);
    webRequest.onErrorOccurred.removeListener(onError as never);
  };
}

/**
 * Copies a text response as it passes through to the page, up to a limit: Firefox's `filterResponseData`.
 *
 * It also holds a document's bytes until its hooks are in (`hookDocument`). Injecting at `onCommitted` alone is a race
 * the page's inline scripts can win, since the script travels through several processes, and a `confirm()` the hooks
 * miss is a native dialog that blocks the page. Without its bytes the document has committed but can't run anything.
 */
function captureBody(
  state: TabState,
  entry: RequestEntry,
  details: {
    requestId: string;
    frameId: number;
    type: string;
    responseHeaders?: { name: string; value?: string }[];
  },
) {
  const type =
    details.responseHeaders?.find((header) => header.name.toLowerCase() === "content-type")?.value ?? "";
  if (!TEXT_TYPE.test(type)) {
    entry.bodyNote = `${type || "binary"}, not kept`;
    return;
  }
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const decoder = new TextDecoder();
  let text = "";
  let over = false;
  const isDocument = details.type !== "xmlhttprequest";
  let held: ArrayBuffer[] | null = isDocument ? [] : null;
  let stopped = false;
  const letThrough = () => {
    if (!held) return;
    for (const chunk of held) filter.write(chunk);
    held = null;
    if (stopped) filter.close();
  };
  if (isDocument) {
    state.gates.set(details.frameId, letThrough);
    setTimeout(letThrough, HOLD_LIMIT_MS);
  }
  filter.ondata = (event: { data: ArrayBuffer }) => {
    if (held) held.push(event.data);
    else filter.write(event.data);
    if (over) return;
    if (text.length + event.data.byteLength > BODY_LIMIT) {
      over = true;
      entry.bodyNote = `over ${BODY_LIMIT} bytes, not kept`;
      text = "";
      return;
    }
    text += decoder.decode(event.data, { stream: true });
  };
  filter.onstop = () => {
    stopped = true;
    if (!held) filter.close();
    if (over) return;
    state.bodyBytes += text.length;
    entry.body = text;
    // Forget the oldest bodies first
    for (const old of state.requests) {
      if (state.bodyBytes <= BODIES_TOTAL_LIMIT) break;
      if (old.body && old !== entry) {
        state.bodyBytes -= old.body.length;
        delete old.body;
        old.bodyNote = "dropped to save memory";
      }
    }
  };
  filter.onerror = () => {
    entry.bodyNote = "not available";
  };
}

// --- Claiming ---

export async function claim(tabId: number, app: AppInfo): Promise<TabState> {
  const tab = await exposedTab(tabId);
  let state = claimed.get(tabId);
  if (!state) {
    state = {
      tabId,
      app,
      navEpoch: 0,
      loading: tab.status === "loading",
      committed: tab.status === "loading",
      navUrl: null,
      supersededUrl: null,
      gotoPending: false,
      focusFrame: 0,
      navError: null,
      gates: new Map(),
      frameAliases: new Map(),
      nextFrameAlias: 1,
      refDocs: new Map(),
      policy: null,
      console: [],
      consoleSeq: 0,
      errorCount: 0,
      lastError: undefined,
      requests: [],
      requestSeq: 0,
      requestsById: new Map(),
      bodyBytes: 0,
      dialogs: [],
      opened: [],
      stopTracking: () => {},
    };
    state.stopTracking = trackRequests(state);
    claimed.set(tabId, state);
    // Already-open pages get the hooks from now on; what they logged earlier is gone
    const frames = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
    await Promise.all(frames.map((frame) => inject(tabId, frame.frameId).catch(() => {})));
  } else {
    state.app = app;
  }
  await groupTab(tabId, app);
  return state;
}

/** Stops driving the tab: the hooks in its pages pass everything through, and its request listeners go */
export async function release(tabId: number) {
  const state = claimed.get(tabId);
  if (!state) return;
  state.stopTracking();
  claimed.delete(tabId);
  try {
    await browser.tabs.sendMessage(tabId, { op: "dispose" });
  } catch {
    // The tab closed, or its pages have no script
  }
}

export async function releaseAll() {
  await Promise.all(Array.from(claimed.keys()).map(release));
}

export function addConsoleEntries(state: TabState, entries: Omit<ConsoleEntry, "seq">[]) {
  for (const entry of entries) {
    state.console.push({ ...entry, seq: ++state.consoleSeq });
    if (entry.type === "error" || entry.type === "uncaught") {
      state.errorCount++;
      state.lastError = entry.text;
    }
  }
  if (state.console.length > MAX_LOG) {
    state.console.splice(0, state.console.length - MAX_LOG);
  }
}

// --- Navigation tracking ---

/**
 * `about:blank`'s events while a navigation is going elsewhere say nothing about that navigation: they're a new tab's
 * first load finishing late, or the blank document Firefox shows while it moves a tab to another process
 */
function isLeftover(state: TabState, url: string): boolean {
  if (url !== "about:blank") return false;
  return state.gotoPending || (state.navUrl !== null && state.navUrl !== "about:blank");
}

function onBeforeNavigate(details: { tabId: number; frameId: number; url: string }) {
  if (details.frameId !== 0) return;
  const state = claimed.get(details.tabId);
  if (!state || isLeftover(state, details.url)) return;
  state.gotoPending = false;
  state.navEpoch++;
  state.loading = true;
  state.committed = false;
  state.supersededUrl = state.navUrl ?? state.supersededUrl;
  state.navUrl = details.url;
  state.navError = null;
}

function onCommitted(details: { tabId: number; frameId: number; url: string }) {
  const state = claimed.get(details.tabId);
  if (!state) return;
  if (details.frameId === 0 && isLeftover(state, details.url)) return;
  // Firefox's error page, which commits under the URL that failed. It takes no scripts
  if (details.frameId === 0 && state.navError && details.url === state.navUrl) return;
  if (details.frameId === 0) {
    // A navigation with no `onBeforeNavigate` of its own: out of the back/forward cache, or refused at once
    if (!state.loading) {
      state.navEpoch++;
      state.loading = true;
    }
    state.gotoPending = false;
    state.navUrl = details.url;
    state.committed = true;
    state.focusFrame = 0;
    state.navError = null;
    state.frameAliases.clear();
    state.refDocs.clear();
  }
  void hookDocument(state, details.frameId);
}

/**
 * Loads the script into a document that just committed, then lets its bytes through (`captureBody` holds them), so the
 * hooks are in place and any dialog answer is set before the page's first script runs
 */
async function hookDocument(state: TabState, frameId: number) {
  try {
    await inject(state.tabId, frameId);
    if (state.policy) {
      await browser.tabs.sendMessage(state.tabId, { op: "dialogPolicy", args: { policy: state.policy } }, { frameId });
    }
  } catch {
    // A page extensions can't run on, or one already gone
  } finally {
    state.gates.get(frameId)?.();
  }
}

function onCompleted(details: { tabId: number; frameId: number; url: string }) {
  if (details.frameId !== 0) return;
  const state = claimed.get(details.tabId);
  if (!state || isLeftover(state, details.url)) return;
  if (state.committed) state.loading = false;
}

const ABORTED = 2152398850;

/** Long enough for a navigation to start over in another process, as the next comment says */
const RESTART_GRACE_MS = 400;

/**
 * Called when a navigation may have ended without a new document, as a download or a response with no content do. It may
 * not have: moving a tab to another process aborts the navigation and starts it over at once with a new
 * `onBeforeNavigate`. So it's over only if nothing has happened a moment later
 */
function endNavigationSoon(state: TabState) {
  const epoch = state.navEpoch;
  setTimeout(() => {
    if (state.navEpoch === epoch && !state.committed) state.loading = false;
  }, RESTART_GRACE_MS);
}

/** Firefox reports network errors as `Error code <nsresult>` */
const NETWORK_ERRORS: Record<number, string> = {
  2152398861: "the connection was refused",
  2152398862: "the connection timed out",
  2152398868: "the connection was reset",
  2152398878: "the server wasn't found",
  2152398879: "there were too many redirects",
  2153390067: "the site's certificate isn't trusted",
};

function describeNavigationError(error: string | undefined): string {
  const code = Number(/(\d{6,})/.exec(error ?? "")?.[1]);
  return NETWORK_ERRORS[code] ?? error ?? "the page didn't load";
}

function onNavigationError(details: { tabId: number; frameId: number; url: string; error?: string }) {
  if (details.frameId !== 0) return;
  const state = claimed.get(details.tabId);
  if (!state) return;
  if (isLeftover(state, details.url)) return;
  if (details.error?.includes(String(ABORTED))) {
    // An older navigation is just replaced, by the one going on now. This one being aborted may not be its end either
    if (details.url === state.navUrl) endNavigationSoon(state);
    return;
  }
  state.loading = false;
  state.navError = describeNavigationError(details.error);
}

/** The only sign of some failures, such as a blocked port, and it says what went wrong */
function onDOMContentLoaded(details: { tabId: number; frameId: number; url: string }) {
  if (details.frameId !== 0 || !/^about:(neterror|certerror)/.test(details.url)) return;
  const state = claimed.get(details.tabId);
  if (!state || state.gotoPending) return;
  const params = new URL(details.url).searchParams;
  const failed = params.get("u");
  if (failed && failed === state.supersededUrl && failed !== state.navUrl) return;
  state.loading = false;
  state.navError ??= params.get("d") || params.get("e") || "the page didn't load";
}

function onTabRemoved(tabId: number) {
  const state = claimed.get(tabId);
  if (state) {
    state.stopTracking();
    claimed.delete(tabId);
  }
}

/** A claimed tab's page opened this tab, so it's the agent's too */
function onTabCreated(tab: browser.tabs.Tab) {
  if (tab.openerTabId === undefined || tab.id === undefined) return;
  const opener = claimed.get(tab.openerTabId);
  if (!opener) return;
  const openedId = tab.id;
  opener.opened.push({ tabId: openedId, url: tab.url ?? "" });
  void claimOpened(openedId, opener.app);
}

async function claimOpened(tabId: number, app: AppInfo) {
  try {
    await claim(tabId, app);
  } catch (error) {
    console.debug("firefox-mcp: couldn't claim an opened tab", error);
  }
}

export function startTabTracking() {
  const navigation = browser.webNavigation;
  navigation.onBeforeNavigate.addListener(onBeforeNavigate);
  navigation.onCommitted.addListener(onCommitted);
  navigation.onDOMContentLoaded.addListener(onDOMContentLoaded);
  navigation.onCompleted.addListener(onCompleted);
  navigation.onErrorOccurred.addListener(onNavigationError);
  browser.tabs.onRemoved.addListener(onTabRemoved);
  browser.tabs.onCreated.addListener(onTabCreated);
}

/**
 * The content script: loaded into every frame of a tab an agent claimed, at the start of each document. It answers the
 * background's operations without waiting: an operation that can't happen yet answers `retry`, and the background
 * polls, since timers in a background tab are throttled and a navigation may replace this script at any moment.
 */
import type { Metrics, Target, UploadFile } from "../../protocol";
import { fromBase64 } from "../../protocol";
import { checkedState } from "./aria";
import { deepElements, isVisible } from "./dom";
import { armFileChooser, installHooks, noteAction, setDialogPolicy, setHooksEnabled } from "./hooks";
import {
  checkActionable,
  click,
  drag,
  fill,
  moveTo,
  type PointerOptions,
  press,
  selectOptions,
  typeText,
} from "./input";
import { LocatorError, query } from "./locator";
import { DOC_ID, elementForRef, refFor, snapshot } from "./snapshot";

export type OpResult =
  | { ok: true; value?: unknown }
  /** Nothing matches in this frame (yet) */
  | { none: true }
  /** It matches, but can't take the action yet: the message is for when time runs out */
  | { retry: string }
  | { error: string };

type WireTarget = Target & { doc?: string };

export type OpMessage = {
  op: string;
  target?: WireTarget;
  args?: Record<string, unknown>;
};

const ok = (value?: unknown): OpResult => ({ ok: true, value });

function staleRef(source: string) {
  return `Ref ${source} isn't on the page anymore. Run \`snapshot -i\` or use a locator`;
}

/** The target's one element, or the result that says why there isn't one */
function resolveOne(target: WireTarget): { el: Element } | { result: OpResult } {
  if (target.kind === "ref") {
    if (target.doc && target.doc !== DOC_ID) return { result: { error: staleRef(target.source) } };
    const el = elementForRef(target.ref);
    return el ? { el } : { result: { error: staleRef(target.source) } };
  }
  const found = query(target);
  if (found.length === 0) return { result: { none: true } };
  if (found.length > 1) {
    return {
      result: {
        error: `${target.source} matched ${found.length} elements. Use a ref from \`snapshot -i\`, add { exact: true }, or pick one with .first() or .nth(i)`,
      },
    };
  }
  return { el: found[0]! };
}

function withElement(target: WireTarget | undefined, run: (el: Element, source: string) => OpResult | Promise<OpResult>): OpResult | Promise<OpResult> {
  if (!target) return { error: "Missing <target>" };
  const resolved = resolveOne(target);
  if ("result" in resolved) return resolved.result;
  return run(resolved.el, target.source);
}

function pointerAction(target: WireTarget | undefined, force: boolean, run: (point: { el: Element; hit: Element; x: number; y: number }) => OpResult | void): OpResult | Promise<OpResult> {
  return withElement(target, (el, source) => {
    const point = checkActionable(el, source, force);
    if (!point.ok) return { retry: point.message };
    noteAction();
    return run(point) ?? ok();
  });
}

function openNewTab(url: string) {
  void browser.runtime.sendMessage({ type: "openTab", url }).catch(() => {});
}

function setChecked(el: Element, source: string, wanted: boolean, target: WireTarget | undefined): OpResult | Promise<OpResult> {
  const current = checkedState(el);
  if (current === undefined) return { error: `${source} isn't a checkbox, radio or switch` };
  if (current === wanted) return ok({ note: `already ${wanted ? "checked" : "unchecked"}` });
  return pointerAction(target, false, (point) => {
    click(point, {}, openNewTab);
    if (checkedState(el) !== wanted) {
      return { error: `Clicking ${source} didn't ${wanted ? "check" : "uncheck"} it` };
    }
    return ok();
  });
}

function toFiles(files: UploadFile[]): File[] {
  return files.map((file) => new File([fromBase64(file.base64)], file.name, { type: file.mimeType }));
}

function setFiles(input: HTMLInputElement, files: File[]) {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

/** A file input the target stands for: itself, inside it, or tied to it by a label */
function fileInputFor(el: Element): HTMLInputElement | null {
  const isFile = (node: Element | null | undefined): node is HTMLInputElement =>
    node?.localName === "input" && (node as HTMLInputElement).type === "file";
  if (isFile(el)) return el;
  const control = (el as HTMLLabelElement).control;
  if (isFile(control)) return control;
  for (const node of deepElements(el)) if (isFile(node)) return node;
  const label = el.closest("label");
  return isFile(label?.control) ? (label!.control as HTMLInputElement) : null;
}

async function upload(el: Element, source: string, files: UploadFile[]): Promise<OpResult> {
  const prepared = toFiles(files);
  const input = fileInputFor(el);
  if (input) {
    setFiles(input, prepared);
    return ok();
  }
  // Neither: the page makes its input when clicked, so catch the picker it opens
  const point = checkActionable(el, source);
  if (!point.ok) return { retry: point.message };
  const chosen = new Promise<boolean>((resolve) => {
    armFileChooser((picked) => {
      setFiles(picked, prepared);
      resolve(true);
    });
    setTimeout(() => resolve(false), 2000);
  });
  noteAction();
  click(point, {}, openNewTab);
  const done = await chosen;
  armFileChooser(null);
  return done
    ? ok()
    : { error: `Clicking ${source} didn't open a file picker. Target the <input type=file>` };
}

type EvalOutcome = { json: string | undefined; world: "page" | "isolated" };

/** Serializes what `eval` returned, in the realm it came from */
const CALL = (source: string, arg: string) => `(async () => {
  const __fn = (${source}
);
  const __value = typeof __fn === "function" ? await __fn(${arg}) : __fn;
  if (__value === undefined) return undefined;
  try { return JSON.stringify(__value) ?? String(__value); } catch { return String(__value); }
})()`;

/**
 * Runs code in the page. A strict CSP blocks that, so it falls back to this script's isolated world, where code still
 * sees the DOM (and the page's variables through `window.wrappedJSObject`), and reports that it did
 */
async function evaluate(source: string, el: Element | undefined): Promise<EvalOutcome> {
  const page = (window as unknown as { wrappedJSObject: Record<string, unknown> & { eval(code: string): Promise<string | undefined> } }).wrappedJSObject;
  const key = `__ffmcp_arg_${Math.random().toString(36).slice(2)}`;
  const arg = el ? `(() => { const __el = window.${key}; delete window.${key}; return __el; })()` : "";
  try {
    if (el) page[key] = el;
    return { json: await page.eval(CALL(source, arg)), world: "page" };
  } catch (error) {
    if (!/CSP/.test(String(error))) {
      if (el) delete page[key];
      throw error;
    }
    if (el) delete page[key];
  }
  const scope = globalThis as unknown as Record<string, unknown>;
  const isolatedKey = `__ffmcp_isolated_${Math.random().toString(36).slice(2)}`;
  if (el) scope[isolatedKey] = el;
  try {
    const code = CALL(source, el ? `globalThis.${isolatedKey}` : "");
    // Indirect: it runs in the sandbox's global scope, without this module's variables
    return { json: await (0, eval)(code), world: "isolated" };
  } finally {
    delete scope[isolatedKey];
  }
}

function metrics(): Metrics {
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    dpr: window.devicePixelRatio,
  };
}

/** The element's box in document coordinates, with the scroll that takes it back to the frame's viewport */
function documentBox(el: Element) {
  const box = el.getBoundingClientRect();
  return {
    x: box.left + window.scrollX,
    y: box.top + window.scrollY,
    width: box.width,
    height: box.height,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

const SCROLL_DIRECTIONS = new Set(["down", "up", "top", "bottom"]);

/** Scrolls the element's scroll area, or the page, or an app's largest pane when the page itself doesn't scroll */
function scrollArea(el: Element | null, direction: string, px: number | null) {
  const root = document.scrollingElement ?? document.documentElement;
  const scrolls = (node: Element) =>
    /auto|scroll|overlay/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight;
  let box: Element = root;
  for (let node: Element | null = el; node && node !== root; node = node.parentElement ?? ((node.getRootNode() as ShadowRoot).host || null)) {
    if (scrolls(node)) {
      box = node;
      break;
    }
  }
  if (!el && root.scrollHeight <= root.clientHeight) {
    let largest = 0;
    for (const node of deepElements(document)) {
      if (!scrolls(node)) continue;
      const rect = node.getBoundingClientRect();
      const visible =
        Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)) *
        Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0));
      if (visible > largest) {
        largest = visible;
        box = node;
      }
    }
  }
  const end = box.scrollHeight - box.clientHeight;
  const step = px ?? Math.round((box === root ? innerHeight : box.clientHeight) * 0.8);
  box.scrollTo({
    top: direction === "top" ? 0 : direction === "bottom" ? end : box.scrollTop + (direction === "up" ? -step : step),
    behavior: "instant",
  });
  const top = Math.round(box.scrollTop);
  const max = Math.round(end);
  const what = box !== root ? "the scroll area" : "the page";
  if (max <= 0) return `${what} doesn't scroll`;
  if (top >= max - 1) return `at the bottom of ${what}, ${max} px`;
  if (top <= 0) return `at the top of ${what}`;
  return `at ${top} of ${max} px`;
}

const handlers: Record<string, (message: OpMessage) => OpResult | Promise<OpResult>> = {
  ping: () => ok(),
  snapshot: () => ok(snapshot()),
  metrics: () => ok(metrics()),
  title: () => ok(document.title),

  click({ target, args }) {
    const options = (args ?? {}) as PointerOptions;
    return withElement(target, (el) => {
      // An option of a <select> has no box to click while the list is closed, so it's selected directly
      if (el.localName === "option") {
        const select = (el as HTMLOptionElement).closest("select");
        if (select) {
          return resultOf(selectOptions(select, [(el as HTMLOptionElement).value], target!.source));
        }
      }
      return pointerAction(target, !!options.force, (point) => {
        click(point, options, openNewTab);
      });
    });
  },
  hover({ target }) {
    return pointerAction(target, false, (point) => {
      moveTo(point.hit, point.x, point.y);
    });
  },
  drag({ target, args }) {
    const to = args?.to as WireTarget;
    return pointerAction(target, false, (from) => {
      const resolved = resolveOne(to);
      if ("result" in resolved) {
        return "none" in resolved.result ? { error: `Nothing matches ${to.source}` } : resolved.result;
      }
      const end = checkActionable(resolved.el, to.source, true);
      if (!end.ok) return { retry: end.message };
      drag(from, end);
    });
  },
  fill({ target, args }) {
    return withElement(target, (el, source) => {
      if (!isVisible(el) && el.localName !== "input") return { retry: `${source} isn't visible` };
      noteAction();
      return resultOf(fill(el, String(args?.text ?? ""), source));
    });
  },
  type({ args }) {
    noteAction();
    return resultOf(typeText(String(args?.text ?? ""), !!args?.slowly));
  },
  press({ args }) {
    noteAction();
    return resultOf(press(String(args?.key ?? "")));
  },
  select({ target, args }) {
    return withElement(target, (el, source) => {
      noteAction();
      return resultOf(selectOptions(el, args?.values as string[], source));
    });
  },
  check({ target }) {
    return withElement(target, (el, source) => setChecked(el, source, true, target));
  },
  uncheck({ target }) {
    return withElement(target, (el, source) => setChecked(el, source, false, target));
  },
  upload({ target, args }) {
    return withElement(target, (el, source) => upload(el, source, args?.files as UploadFile[]));
  },
  scrollTo({ target }) {
    return withElement(target, (el) => {
      el.scrollIntoView({ block: "center", behavior: "instant" });
      return ok();
    });
  },
  scroll({ target, args }) {
    const direction = String(args?.direction);
    if (!SCROLL_DIRECTIONS.has(direction)) return { error: "scroll takes down, up, top, bottom or a target" };
    const px = typeof args?.px === "number" ? args.px : null;
    if (!target) return ok({ note: scrollArea(null, direction, px) });
    return withElement(target, (el) => ok({ note: scrollArea(el, direction, px) }));
  },
  text({ target }) {
    if (!target) return ok(document.body?.innerText ?? "");
    return withElement(target, (el) => ok((el as HTMLElement).innerText ?? el.textContent ?? ""));
  },
  value({ target }) {
    return withElement(target, (el, source) => {
      const field = el as HTMLInputElement;
      if (field.value !== undefined) return ok(String(field.value));
      if (field.isContentEditable) return ok(field.textContent ?? "");
      return { error: `${source} isn't a field with a value` };
    });
  },
  attr({ target, args }) {
    return withElement(target, (el) => ok(el.getAttribute(String(args?.name))));
  },
  /** The target's ref, to scope a snapshot */
  ref({ target }) {
    return withElement(target, (el) => ok({ ref: refFor(el) }));
  },
  box({ target }) {
    return withElement(target, (el, source) => {
      const rect = el.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      }
      if (!isVisible(el)) return { retry: `${source} isn't visible` };
      return ok(documentBox(el));
    });
  },
  /** How many elements match */
  count({ target, args }) {
    if (!target || target.kind === "ref") return { error: "count takes a locator or CSS selector" };
    const found = query(target);
    return ok(args?.visibleOnly ? found.filter(isVisible).length : found.length);
  },
  /** The frame of an <iframe> target */
  frameOf({ target }) {
    return withElement(target, (el, source) => {
      if (el.localName !== "iframe" && el.localName !== "frame") return { error: `${source} isn't an iframe` };
      const frameId = browser.runtime.getFrameId(el);
      return frameId >= 0 ? ok({ frameId }) : { retry: `${source} hasn't loaded` };
    });
  },
  /** Where an iframe of this document sits, to place a child frame's element in the page */
  frameOffset({ args }) {
    for (const el of deepElements(document)) {
      if (el.localName !== "iframe" && el.localName !== "frame") continue;
      if (browser.runtime.getFrameId(el) === args?.frameId) {
        const box = documentBox(el);
        return ok({ x: box.x + el.clientLeft, y: box.y + el.clientTop });
      }
    }
    return { error: "That iframe isn't in this frame" };
  },
  eval({ target, args }) {
    const source = String(args?.source ?? "");
    const run = async (el?: Element): Promise<OpResult> => {
      try {
        return ok(await evaluate(source, el));
      } catch (error) {
        const e = error as { name?: string; message?: string };
        return { error: `${e?.name ?? "Error"}: ${e?.message ?? String(error)}` };
      }
    };
    noteAction();
    if (!target) return run();
    return withElement(target, (el) => run(el));
  },
  dialogPolicy({ args }) {
    setDialogPolicy((args?.policy as { accept: boolean; text?: string } | null) ?? null);
    return ok();
  },
  dispose() {
    setHooksEnabled(false);
    return ok();
  },
};

function resultOf(message: string | null): OpResult {
  return message ? { error: message } : ok();
}

async function handle(message: OpMessage): Promise<OpResult> {
  const handler = Object.hasOwn(handlers, message.op) ? handlers[message.op] : undefined;
  if (!handler) return { error: `Unknown operation ${message.op}` };
  try {
    return await handler(message);
  } catch (error) {
    if (error instanceof LocatorError) return { error: error.message };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function main() {
  installHooks();
  browser.runtime.onMessage.addListener((message: unknown) => {
    const op = message as OpMessage;
    return typeof op?.op === "string" ? handle(op) : undefined;
  });
  // A policy set before this document loaded
  void browser.runtime
    .sendMessage({ type: "contentReady" })
    .then((reply: { policy?: { accept: boolean; text?: string } | null } | undefined) => {
      if (reply?.policy) setDialogPolicy(reply.policy);
    })
    .catch(() => {});
}

// It's injected at each commit and again on demand, into a sandbox that lasts as long as the document
const scope = globalThis as unknown as { __ffmcpLoaded?: boolean };
if (!scope.__ffmcpLoaded) {
  scope.__ffmcpLoaded = true;
  main();
}

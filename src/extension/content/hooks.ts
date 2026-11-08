/**
 * What a debugger would report, this learns by wrapping page functions: console messages, dialogs, and
 * `window.open`. `exportFunction` makes a function of this isolated world callable from the page, so nothing is
 * injected into the page's world, no page CSP applies, and the page can't forge what's reported. It runs only in tabs
 * an agent claimed.
 *
 * A dialog can't wait for an answer, since `confirm()` has to return before the page's script goes on, and a native one
 * would block this script too. So the answer is set beforehand (`dialog accept`) and otherwise it's dismissed.
 */
import type { ConsoleEntry, DialogEntry } from "../../protocol";

/** Firefox makes a function of this isolated world callable from the page */
declare function exportFunction(fn: (...args: never[]) => unknown, target: object, options: { defineAs: string }): void;

type PageWindow = Window & typeof globalThis;

/** How long after an agent's action a page's `window.open` counts as coming from that action */
const ACTION_WINDOW_MS = 1500;
const POPUPS_PER_ACTION = 3;
const TEXT_LIMIT = 4000;

let enabled = true;
let policy: { accept: boolean; text?: string } | null = null;
let actionUntil = 0;
let popupsLeft = 0;
let fileChooser: ((input: HTMLInputElement) => void) | null = null;

function post(message: unknown) {
  void browser.runtime.sendMessage(message).catch(() => {});
}

export function setDialogPolicy(next: { accept: boolean; text?: string } | null) {
  policy = next;
}

export function setHooksEnabled(value: boolean) {
  enabled = value;
}

/** Called around an agent's action, during which the page's popups are treated as user-initiated */
export function noteAction() {
  actionUntil = Date.now() + ACTION_WINDOW_MS;
  popupsLeft = POPUPS_PER_ACTION;
}

/** The next time the page opens a file picker, `onInput` gets its input instead of a blocked picker */
export function armFileChooser(onInput: ((input: HTMLInputElement) => void) | null) {
  fileChooser = onInput;
}

// --- Console ---

let queue: Omit<ConsoleEntry, "seq">[] = [];
let flushScheduled = false;

function report(type: string, text: string, location?: string) {
  if (!enabled) return;
  const capped =
    text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text;
  queue.push({ type, text: capped, ...(location ? { location } : {}) });
  // A microtask, not a timer: Firefox throttles timers in background tabs to about a second
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const entries = queue;
    queue = [];
    post({ type: "console", entries });
  });
}

/** A readable form of a console argument. Page objects arrive through Xray wrappers, so no page code runs here */
function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") {
    return typeof value === "function" ? "[function]" : String(value);
  }
  try {
    const object = value as { message?: unknown; name?: unknown; localName?: unknown };
    if (typeof object.message === "string" && typeof object.name === "string") {
      return `${object.name}: ${object.message}`;
    }
    if (typeof object.localName === "string") return `<${object.localName}>`;
    return JSON.stringify(value) ?? Object.prototype.toString.call(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function hookConsole(page: PageWindow) {
  const pageConsole = page.console;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = pageConsole[level];
    exportFunction(
      function (...args: unknown[]) {
        try {
          report(level, args.map(format).join(" "));
        } catch {}
        Reflect.apply(original, pageConsole, args);
      },
      pageConsole,
      { defineAs: level },
    );
  }
  window.addEventListener("error", (event) => {
    if (!event.message) return;
    const location = event.filename ? `${event.filename}:${event.lineno}` : undefined;
    report("uncaught", event.message, location);
  });
  window.addEventListener("unhandledrejection", (event) => {
    report("uncaught", `Unhandled rejection: ${format(event.reason)}`);
  });
}

// --- Dialogs ---

function answerDialog(kind: DialogEntry["kind"], message: unknown): { accept: boolean; text?: string } {
  const used = policy;
  policy = null;
  const accept = used ? used.accept : kind === "alert";
  const shown =
    kind === "alert" ? "OK" : !accept ? "dismissed" : kind === "prompt" ? `accepted with ${JSON.stringify(used?.text ?? "")}` : "accepted";
  const entry: DialogEntry = {
    kind,
    message: String(message ?? ""),
    answer: shown,
    automatic: !used,
  };
  post({ type: "dialog", entry, consumedPolicy: !!used });
  return { accept, text: used?.text };
}

function hookDialogs(page: PageWindow) {
  const original = {
    alert: page.alert,
    confirm: page.confirm,
    prompt: page.prompt,
  };
  exportFunction(
    function (message?: unknown) {
      if (!enabled) return Reflect.apply(original.alert, page, [message]);
      answerDialog("alert", message);
      return undefined;
    },
    page,
    { defineAs: "alert" },
  );
  exportFunction(
    function (message?: unknown) {
      if (!enabled) return Reflect.apply(original.confirm, page, [message]);
      return answerDialog("confirm", message).accept;
    },
    page,
    { defineAs: "confirm" },
  );
  exportFunction(
    function (message?: unknown, fallback?: unknown) {
      if (!enabled) return Reflect.apply(original.prompt, page, [message, fallback]);
      const answer = answerDialog("prompt", message);
      if (!answer.accept) return null;
      return answer.text ?? (fallback === undefined ? "" : String(fallback));
    },
    page,
    { defineAs: "prompt" },
  );
}

// --- window.open and file pickers ---

function hookPopups(page: PageWindow) {
  const original = page.open;
  exportFunction(
    function (url?: unknown, target?: unknown, features?: unknown) {
      const opened = Reflect.apply(original, page, [url, target, features]);
      // Blocked: a synthetic click isn't a user gesture. An agent's click opens it through the extension instead, though the page gets no window object
      if (!opened && enabled && url !== undefined && Date.now() < actionUntil && popupsLeft > 0) {
        popupsLeft--;
        try {
          const absolute = new URL(String(url), location.href).href;
          if (/^https?:/.test(absolute)) post({ type: "openTab", url: absolute });
        } catch {}
      }
      return opened;
    },
    page,
    { defineAs: "open" },
  );
}

function hookFilePicker(page: PageWindow) {
  const proto = (page as unknown as { HTMLInputElement: typeof HTMLInputElement })
    .HTMLInputElement.prototype;
  for (const method of ["click", "showPicker"] as const) {
    const original = proto[method];
    exportFunction(
      function (this: HTMLInputElement) {
        if (fileChooser && this.type === "file") {
          const chooser = fileChooser;
          fileChooser = null;
          chooser(this);
          return undefined;
        }
        return Reflect.apply(original, this, []);
      },
      proto,
      { defineAs: method },
    );
  }
}

export function installHooks() {
  const page = (window as unknown as { wrappedJSObject: PageWindow }).wrappedJSObject;
  for (const install of [hookConsole, hookDialogs, hookPopups, hookFilePicker]) {
    try {
      install(page);
    } catch (error) {
      console.debug("firefox-mcp: hook failed", error);
    }
  }
}


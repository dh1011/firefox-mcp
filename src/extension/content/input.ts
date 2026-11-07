/**
 * Input without `chrome.debugger`. Firefox gives extensions no way to send real input, so:
 *
 * - Text goes in through `document.execCommand("insertText")`, whose `beforeinput` and `input` events are trusted, and
 *   which frameworks and rich editors treat like typing. Assigning `value` here goes through the Xray wrapper to the
 *   native setter, so React's value tracker still sees a change.
 * - Pointer and key events are synthesized, so they're `isTrusted: false`, and their default actions have to be done
 *   here: moving focus, following Tab, implicit form submission and so on.
 *
 * What this can't reach: pages that check `isTrusted`, and anything needing real user activation (see README).
 */
import { deepActiveElement, deepContains, deepElementFromPoint, describeElement, isVisible } from "./dom";
import { isDisabled, labelsOf } from "./aria";

export type PointerOptions = {
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: string[];
  force?: boolean;
};

type ModifierFlags = {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

const IS_MAC = navigator.platform.startsWith("Mac");

function modifierFlags(modifiers: string[] = []): ModifierFlags {
  const has = (name: string) => modifiers.includes(name);
  return {
    altKey: has("Alt"),
    ctrlKey: has("Control") || (has("ControlOrMeta") && !IS_MAC),
    metaKey: has("Meta") || (has("ControlOrMeta") && IS_MAC),
    shiftKey: has("Shift"),
  };
}

// --- Actionability ---

export type Actionable =
  | { ok: true; el: Element; x: number; y: number; hit: Element }
  | { ok: false; message: string };

/** A visually hidden checkbox, radio or file input is clicked through its visible label, as users do */
function retarget(el: Element): Element {
  if (el.localName !== "input") return el;
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const hidden =
    box.width === 0 ||
    box.height === 0 ||
    style.visibility === "hidden" ||
    style.opacity === "0";
  if (!hidden) return el;
  return labelsOf(el).find(isVisible) ?? el;
}

/** Scrolls the element into view, and checks it would take a click: visible, enabled and not covered */
export function checkActionable(original: Element, source: string, force = false): Actionable {
  const el = retarget(original);
  let box = el.getBoundingClientRect();
  if (box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    box = el.getBoundingClientRect();
  }
  if (!isVisible(el)) return { ok: false, message: `${source} isn't visible` };
  if (isDisabled(original)) return { ok: false, message: `${source} is disabled` };
  const x = box.left + Math.min(box.width, innerWidth - box.left) / 2;
  const y = box.top + Math.min(box.height, innerHeight - box.top) / 2;
  if (x < 0 || y < 0) return { ok: false, message: `${source} is outside the page` };
  const hit = deepElementFromPoint(x, y);
  if (force || !hit || deepContains(el, hit)) {
    return { ok: true, el, x, y, hit: hit && deepContains(el, hit) ? hit : el };
  }
  // A label receives the click for its control, and an element inside the target's own label is fine
  for (const label of labelsOf(original)) {
    if (deepContains(label, hit)) return { ok: true, el, x, y, hit };
  }
  // An <option> or the like inside something drawn over it by the browser
  return {
    ok: false,
    message: `${source} is covered by \`${describeElement(hit)}\`. Close or dismiss it first, or use --force to send the click to it anyway`,
  };
}

// --- Pointer ---

function pointerEvent(type: string, el: Element, init: MouseEventInit) {
  el.dispatchEvent(
    new PointerEvent(type, {
      ...init,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    }),
  );
}

function mouseEvent(type: string, el: Element, init: MouseEventInit): boolean {
  return el.dispatchEvent(new MouseEvent(type, init));
}

function baseInit(x: number, y: number, flags: ModifierFlags): MouseEventInit {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    ...flags,
  };
}

export function moveTo(el: Element, x: number, y: number, flags: ModifierFlags = modifierFlags()) {
  const init = baseInit(x, y, flags);
  pointerEvent("pointerover", el, init);
  pointerEvent("pointerenter", el, { ...init, bubbles: false });
  mouseEvent("mouseover", el, init);
  mouseEvent("mouseenter", el, { ...init, bubbles: false });
  pointerEvent("pointermove", el, init);
  mouseEvent("mousemove", el, init);
}

function focusableAncestor(el: Element): HTMLElement | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const html = node as HTMLElement;
    if (html.tabIndex >= 0 || html.isContentEditable || node.localName === "label") {
      return html;
    }
  }
  return null;
}

/** A mouse press moves focus (and puts a caret in an editing host) unless the page prevents it */
function focusFromPress(hit: Element) {
  const target = focusableAncestor(hit);
  if (target && target.localName !== "label") {
    target.focus({ preventScroll: true });
    placeCaretIfNone(target);
  } else if (!target) {
    (deepActiveElement() as HTMLElement | null)?.blur?.();
  }
}

/** Where a link would open a new window, which the popup blocker stops for synthetic clicks */
function newTabLinkUrl(hit: Element, flags: ModifierFlags, button: number): string | null {
  const anchor = hit.closest("a[href], area[href]") as HTMLAnchorElement | null;
  if (!anchor) return null;
  const opensNewTab =
    /^_blank$/i.test(anchor.target) ||
    button === 1 ||
    (button === 0 && (flags.ctrlKey || flags.metaKey));
  return opensNewTab && /^https?:/.test(anchor.href) ? anchor.href : null;
}

export function click(
  point: { el: Element; hit: Element; x: number; y: number },
  options: PointerOptions,
  openNewTab: (url: string) => void,
) {
  const { hit, x, y } = point;
  const flags = modifierFlags(options.modifiers);
  const button = options.button === "right" ? 2 : options.button === "middle" ? 1 : 0;
  const buttons = button === 2 ? 2 : button === 1 ? 4 : 1;
  const count = options.clickCount ?? 1;
  moveTo(hit, x, y, flags);
  for (let i = 1; i <= count; i++) {
    const down = { ...baseInit(x, y, flags), button, buttons, detail: i };
    const up = { ...down, buttons: 0 };
    pointerEvent("pointerdown", hit, down);
    if (mouseEvent("mousedown", hit, down) && button === 0) focusFromPress(hit);
    if (!hit.isConnected) return;
    pointerEvent("pointerup", hit, up);
    mouseEvent("mouseup", hit, up);
    if (!hit.isConnected) return;
    if (button === 2) {
      mouseEvent("contextmenu", hit, up);
    } else if (button === 1) {
      fireClick("auxclick", hit, up, flags, button, openNewTab);
    } else {
      fireClick("click", hit, up, flags, button, openNewTab);
    }
  }
  if (count === 2 && button === 0) {
    mouseEvent("dblclick", hit, { ...baseInit(x, y, flags), button, detail: 2 });
  }
}

/**
 * Sends the click, opening a link that targets a new tab through the extension if the page doesn't handle it. The
 * listener runs last on `window`, so `preventDefault` from the page's own handlers is respected
 */
function fireClick(
  type: string,
  hit: Element,
  init: MouseEventInit,
  flags: ModifierFlags,
  button: number,
  openNewTab: (url: string) => void,
) {
  const url = newTabLinkUrl(hit, flags, button);
  if (!url) {
    mouseEvent(type, hit, init);
    return;
  }
  const handler = (event: Event) => {
    if (!event.defaultPrevented) {
      event.preventDefault();
      openNewTab(url);
    }
  };
  window.addEventListener(type, handler, { once: true });
  mouseEvent(type, hit, init);
  window.removeEventListener(type, handler);
}

/** Drag and drop through both the pointer events and the HTML5 ones, since pages listen to one or the other */
export function drag(
  from: { hit: Element; x: number; y: number },
  to: { hit: Element; x: number; y: number },
) {
  const flags = modifierFlags();
  moveTo(from.hit, from.x, from.y, flags);
  const down = { ...baseInit(from.x, from.y, flags), button: 0, buttons: 1, detail: 1 };
  pointerEvent("pointerdown", from.hit, down);
  mouseEvent("mousedown", from.hit, down);
  const transfer = new DataTransfer();
  const dragInit = (x: number, y: number): DragEventInit => ({
    ...baseInit(x, y, flags),
    button: 0,
    buttons: 1,
    dataTransfer: transfer,
  });
  const dragEvent = (type: string, el: Element, init: DragEventInit) =>
    el.dispatchEvent(new DragEvent(type, init));
  const draggable = from.hit.closest('[draggable="true"]') ?? from.hit;
  const steps = 5;
  dragEvent("dragstart", draggable, dragInit(from.x, from.y));
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    const over = deepElementFromPoint(x, y) ?? to.hit;
    const move = { ...baseInit(x, y, flags), button: 0, buttons: 1 };
    pointerEvent("pointermove", over, move);
    mouseEvent("mousemove", over, move);
    dragEvent("dragover", over, dragInit(x, y));
  }
  dragEvent("dragenter", to.hit, dragInit(to.x, to.y));
  const dragOver = dragInit(to.x, to.y);
  dragEvent("dragover", to.hit, dragOver);
  dragEvent("drop", to.hit, dragOver);
  dragEvent("dragend", draggable, dragInit(to.x, to.y));
  const up = { ...baseInit(to.x, to.y, flags), button: 0, buttons: 0, detail: 1 };
  pointerEvent("pointerup", to.hit, up);
  mouseEvent("mouseup", to.hit, up);
}

// --- Text ---

/** `<input>` types edited as text. Others (date, color, range…) take a value */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el.localName === "textarea") return true;
  return el.localName === "input" && TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
}

function isEditable(el: Element | null): boolean {
  if (!el) return false;
  return isTextField(el) || (el as HTMLElement).isContentEditable === true;
}

function fire(el: Element, type: string) {
  el.dispatchEvent(new Event(type, { bubbles: true, composed: type === "input" }));
}

/** `execCommand` in a host needs a selection there, which `focus()` doesn't make while the tab is in the background */
function placeCaretIfNone(host: HTMLElement) {
  if (!host.isContentEditable) return;
  const selection = getSelection();
  if (selection && selection.rangeCount > 0 && deepContains(host, selection.anchorNode)) {
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(host);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The field or editing host focus is in */
function editingTarget(): HTMLElement | null {
  const active = deepActiveElement() as HTMLElement | null;
  if (!active || !isEditable(active)) return null;
  return active;
}

/** Inserts at the caret, the way typing does */
function insertAtFocus(text: string): boolean {
  return document.execCommand("insertText", false, text);
}

/** Replaces a field's value (input, textarea, select-free controls, editing hosts) */
export function fill(el: Element, text: string, source: string): string | null {
  const html = el as HTMLElement;
  if (isDisabled(el)) return `${source} is disabled`;
  if ((el as HTMLInputElement).readOnly) return `${source} is read-only`;
  if (isTextField(el)) {
    html.focus({ preventScroll: true });
    el.select();
    const done = text
      ? insertAtFocus(text)
      : el.value === "" || document.execCommand("delete");
    if (!done) {
      el.value = text;
      fire(el, "input");
    }
    fire(el, "change");
    return null;
  }
  if (el.localName === "input") {
    const input = el as HTMLInputElement;
    if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "hidden"].includes(input.type)) {
      return `${source} is a ${input.type} input, which fill doesn't take. Use check, click or upload`;
    }
    // date, time, color, range…: no text editing, so the value is set as a picker would
    input.value = text;
    fire(el, "input");
    fire(el, "change");
    if (text && input.value !== text) {
      return `${source} doesn't accept ${JSON.stringify(text)} as a ${input.type} value`;
    }
    return null;
  }
  if (html.isContentEditable) {
    html.focus({ preventScroll: true });
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(html);
    selection?.removeAllRanges();
    selection?.addRange(range);
    const done = text ? insertAtFocus(text) : document.execCommand("delete");
    if (!done) {
      html.textContent = text;
      fire(el, "input");
    }
    return null;
  }
  return `${source} isn't a field: it needs an input, textarea or contenteditable element`;
}

/** Types into the focused element. Returns an error message, if any */
export function typeText(text: string, slowly: boolean): string | null {
  const target = editingTarget();
  if (!target) {
    return 'Nothing editable is focused. Click a field first, or use `fill <target> "<text>"`';
  }
  placeCaretIfNone(target);
  if (slowly) {
    for (const char of text) press(char);
  } else if (!insertAtFocus(text)) {
    return "The focused element refused the text";
  }
  return null;
}

// --- Keys ---

type KeyInfo = { key: string; code: string; keyCode: number };

const NAMED_KEYS: Record<string, KeyInfo> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
};
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

function keyInfo(key: string, shift: boolean): KeyInfo | null {
  const named = Object.hasOwn(NAMED_KEYS, key) ? NAMED_KEYS[key] : undefined;
  if (named) return named;
  if (Array.from(key).length !== 1) return null;
  const upper = key.toUpperCase();
  let code = "";
  if (/^[a-z]$/i.test(key)) code = `Key${upper}`;
  else if (/^\d$/.test(key)) code = `Digit${key}`;
  return {
    key: shift && /^[a-z]$/.test(key) ? upper : key,
    code,
    keyCode: upper.charCodeAt(0),
  };
}

/** The elements Tab moves through, in order */
function tabbables(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const positive: HTMLElement[] = [];
  const candidates = document.querySelectorAll<HTMLElement>(
    "a[href], area[href], button, input, select, textarea, summary, iframe, [tabindex], [contenteditable]",
  );
  for (const el of candidates) {
    if (el.tabIndex < 0 || isDisabled(el) || !isVisible(el)) continue;
    if (el.tabIndex > 0) positive.push(el);
    else out.push(el);
  }
  positive.sort((a, b) => a.tabIndex - b.tabIndex);
  return [...positive, ...out];
}

function moveFocus(backwards: boolean) {
  const list = tabbables();
  if (!list.length) return;
  const active = deepActiveElement() as HTMLElement | null;
  const index = active ? list.indexOf(active) : -1;
  const next = backwards
    ? list[index <= 0 ? list.length - 1 : index - 1]
    : list[index < 0 || index === list.length - 1 ? 0 : index + 1];
  next?.focus();
  if (next && isTextField(next)) next.select();
}

function moveCaret(key: string, flags: ModifierFlags) {
  const selection = getSelection();
  if (!selection) return;
  const alter = flags.shiftKey ? "extend" : "move";
  const directions: Record<string, [string, string]> = {
    ArrowLeft: ["backward", flags.ctrlKey ? "word" : "character"],
    ArrowRight: ["forward", flags.ctrlKey ? "word" : "character"],
    ArrowUp: ["backward", "line"],
    ArrowDown: ["forward", "line"],
    Home: ["backward", "lineboundary"],
    End: ["forward", "lineboundary"],
  };
  const direction = directions[key];
  if (direction) {
    (selection as Selection & { modify(a: string, d: string, g: string): void }).modify(
      alter,
      direction[0],
      direction[1],
    );
  }
}

/** Moves the caret in a text field, for which `Selection.modify` doesn't work */
function moveFieldCaret(field: HTMLInputElement | HTMLTextAreaElement, key: string, flags: ModifierFlags) {
  let start: number | null;
  try {
    start = field.selectionStart;
  } catch {
    return;
  }
  if (start === null) return;
  const end = field.selectionEnd ?? start;
  const value = field.value;
  const lineStart = value.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = value.indexOf("\n", end);
  if (lineEnd < 0) lineEnd = value.length;
  const caret =
    key === "ArrowLeft"
      ? start === end || flags.shiftKey ? Math.max(0, start - 1) : start
      : key === "ArrowRight"
        ? start === end || flags.shiftKey ? Math.min(value.length, end + 1) : end
        : key === "Home"
          ? lineStart
          : key === "End"
            ? lineEnd
            : null;
  if (caret === null) return;
  if (flags.shiftKey) {
    field.setSelectionRange(Math.min(start, caret), Math.max(end, caret));
  } else {
    field.setSelectionRange(caret, caret);
  }
}

function scrollPageBy(key: string) {
  const step = innerHeight * 0.9;
  const behavior = "instant" as ScrollBehavior;
  if (key === "PageDown" || key === " ") window.scrollBy({ top: step, behavior });
  else if (key === "PageUp") window.scrollBy({ top: -step, behavior });
  else if (key === "ArrowDown") window.scrollBy({ top: 40, behavior });
  else if (key === "ArrowUp") window.scrollBy({ top: -40, behavior });
  else if (key === "Home") window.scrollTo({ top: 0, behavior });
  else if (key === "End") {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }
}

/** Implicit submission: what Enter in a text input does */
function submitForm(field: HTMLInputElement) {
  const form = field.form;
  if (!form) return;
  const submitter = form.querySelector<HTMLElement>(
    'button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]',
  );
  if (submitter && !isDisabled(submitter)) {
    (submitter as HTMLButtonElement).click();
  } else if (!submitter) {
    form.requestSubmit();
  }
}

/** What the key would have done, since a synthetic key event does nothing by itself */
function defaultAction(info: KeyInfo, flags: ModifierFlags, target: HTMLElement) {
  const { key } = info;
  const field = isTextField(target) ? target : null;
  const editing = isEditable(target);
  const command = flags.ctrlKey || flags.metaKey;

  if (key === "Tab") return moveFocus(flags.shiftKey);

  if (command && key.toLowerCase() === "a") {
    if (field) field.select();
    else document.execCommand("selectAll");
    return;
  }
  if (command || flags.altKey) return;

  if (key === "Enter") {
    if (field?.localName === "input") return submitForm(field as HTMLInputElement);
    if (editing) {
      document.execCommand(field ? "insertLineBreak" : "insertParagraph");
      return;
    }
    if (target.localName === "a" || target.localName === "button" || target.localName === "summary" || target.getAttribute("role") === "button" || target.getAttribute("role") === "link") {
      target.click();
    }
    return;
  }
  if (key === " ") {
    if (editing) {
      insertAtFocus(" ");
      return;
    }
    const type = (target as HTMLInputElement).type;
    if (
      target.localName === "button" ||
      target.localName === "summary" ||
      type === "checkbox" ||
      type === "radio" ||
      target.getAttribute("role") === "button" ||
      target.getAttribute("role") === "checkbox"
    ) {
      target.click();
      return;
    }
    scrollPageBy(key);
    return;
  }
  if (key === "Backspace" || key === "Delete") {
    if (editing) {
      document.execCommand(key === "Backspace" ? "delete" : "forwardDelete");
    }
    return;
  }
  if (key === "Escape") {
    // A modal <dialog> closes on Escape
    const modal = Array.from(document.querySelectorAll("dialog")).findLast((dialog) => dialog.matches(":modal"));
    if (modal && modal.dispatchEvent(new Event("cancel", { cancelable: true }))) modal.close();
    return;
  }
  if (target.localName === "select" && (key === "ArrowDown" || key === "ArrowUp")) {
    const select = target as HTMLSelectElement;
    const next = select.selectedIndex + (key === "ArrowDown" ? 1 : -1);
    if (next >= 0 && next < select.options.length) {
      select.selectedIndex = next;
      fire(select, "input");
      fire(select, "change");
    }
    return;
  }
  if (/^(Arrow|Home$|End$)/.test(key) && editing) {
    if (field) moveFieldCaret(field, key, flags);
    else moveCaret(key, flags);
    return;
  }
  if (/^(Arrow|Home$|End$|Page)/.test(key)) {
    scrollPageBy(key);
    return;
  }
  if (Array.from(key).length === 1 && editing) insertAtFocus(key);
}

/** Presses a key or a combination (`Control+a`) on the focused element. Returns an error message, if any */
export function press(combo: string): string | null {
  // `+` itself is a key: "Control++" or "+"
  const parts = combo === "+" ? ["+"] : combo.endsWith("++") ? [...combo.slice(0, -2).split("+"), "+"] : combo.split("+");
  const key = parts.pop() ?? "";
  const flags = modifierFlags(parts);
  for (const modifier of parts) {
    if (!["Alt", "Control", "ControlOrMeta", "Meta", "Shift"].includes(modifier)) {
      return `${modifier} isn't a modifier. Use Alt, Control, ControlOrMeta, Meta or Shift`;
    }
  }
  const info = keyInfo(key, flags.shiftKey);
  if (!info) return `${key} isn't a key. Use e.g. Enter, Tab, Escape, ArrowDown, a, Control+a`;
  const target = (deepActiveElement() ?? document.body) as HTMLElement;
  if (!target) return "The page has no element to take the key";
  const init: KeyboardEventInit & { keyCode: number } = {
    key: info.key,
    code: info.code,
    keyCode: info.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    ...flags,
  };
  let proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
  const printable = Array.from(info.key).length === 1;
  const hasKeypress = printable || info.key === "Enter";
  if (proceed && hasKeypress && !flags.ctrlKey && !flags.altKey && !flags.metaKey) {
    proceed = target.dispatchEvent(
      new KeyboardEvent("keypress", {
        ...init,
        charCode: info.key === "Enter" ? 13 : info.key.codePointAt(0),
      } as KeyboardEventInit),
    );
  }
  if (proceed) defaultAction(info, flags, target);
  const after = (deepActiveElement() ?? document.body) as HTMLElement;
  (after.isConnected ? after : document.body)?.dispatchEvent(
    new KeyboardEvent("keyup", init),
  );
  return null;
}

// --- Select ---

/** Selects options by value or label. Returns an error message, if any */
export function selectOptions(el: Element, values: string[], source: string): string | null {
  if (el.localName !== "select") {
    return `${source} isn't a <select>. For a custom dropdown, click it and then click the option`;
  }
  const select = el as HTMLSelectElement;
  if (isDisabled(select)) return `${source} is disabled`;
  const options = Array.from(select.options);
  const picked: HTMLOptionElement[] = [];
  for (const value of values) {
    const wanted = value.trim();
    const option =
      options.find((item) => item.value === value) ??
      options.find((item) => item.label.trim() === wanted) ??
      options.find((item) => (item.textContent ?? "").trim() === wanted);
    if (!option) {
      const names = options.slice(0, 20).map((item) => JSON.stringify(item.label.trim() || item.value)).join(", ");
      return `No option of ${source} matches ${JSON.stringify(value)}. It has: ${names}`;
    }
    picked.push(option);
  }
  if (picked.length > 1 && !select.multiple) {
    return `${source} takes only one option`;
  }
  if (select.multiple) {
    for (const option of options) option.selected = picked.includes(option);
  } else {
    select.selectedIndex = options.indexOf(picked[0]!);
  }
  fire(select, "input");
  fire(select, "change");
  return null;
}

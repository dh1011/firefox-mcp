/**
 * The accessibility snapshot of one frame, with refs for what an agent can act on. Refs stay the same for an element
 * across snapshots of a document, and carry the document's ID so a ref from before a navigation fails rather than
 * hitting another element on the new page.
 */
import type { AriaNode } from "../../protocol";
import {
  accessibleName,
  checkedState,
  expandedState,
  isDisabled,
  levelOf,
  nameComesFromContent,
  pressedState,
  roleOf,
  selectedState,
} from "./aria";
import { deepActiveElement, shadowOf } from "./dom";

/** This document's ID, made when the script loads */
export const DOC_ID = Math.random().toString(36).slice(2, 10);

const elementsByRef = new Map<string, Element>();
const refsByElement = new Map<Element, string>();
let nextRef = 1;

export function refFor(el: Element): string {
  let ref = refsByElement.get(el);
  if (!ref) {
    ref = `e${nextRef++}`;
    refsByElement.set(el, ref);
    elementsByRef.set(ref, el);
  }
  return ref;
}

export function elementForRef(ref: string): Element | null {
  const el = elementsByRef.get(ref);
  return el?.isConnected ? el : null;
}

/** Drops refs of elements that left the page, so a long-lived page doesn't keep them alive */
function pruneRefs() {
  for (const [ref, el] of elementsByRef) {
    if (!el.isConnected) {
      elementsByRef.delete(ref);
      refsByElement.delete(el);
    }
  }
}

const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "head",
  "meta",
  "link",
  "base",
  "title",
]);

/** Elements whose role adds nothing over their text in a snapshot, so their text flows into the parent's */
const INLINE_TEXT_ROLES = new Set(["code", "term"]);

/** These have no meaningful content below them */
const LEAF_TAGS = new Set(["input", "textarea", "img", "svg", "canvas", "hr", "video", "audio", "progress", "meter"]);

const NODE_LIMIT = 20_000;

type WalkState = {
  count: number;
  active: Element | null;
  /** The text node still being appended to, until a block boundary or another element */
  openText: AriaNode | null;
  /** Inside a label with a control: its text is that control's name already */
  inLabel: boolean;
};

function fieldValue(el: Element): string | undefined {
  const tag = el.localName;
  if (tag === "input" || tag === "textarea") {
    const input = el as HTMLInputElement;
    if (["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "number"].includes(input.type)) {
      return undefined;
    }
    if (!input.value) return undefined;
    // Passwords don't go into a transcript
    return input.type === "password" ? "••••••••" : input.value;
  }
  return undefined;
}

function isBlock(style: CSSStyleDeclaration): boolean {
  return !/^(inline|contents)/.test(style.display);
}

function children(el: Element): Node[] {
  const shadow = shadowOf(el);
  if (shadow) return Array.from(shadow.childNodes);
  if (el.localName === "slot") {
    const assigned = (el as HTMLSlotElement).assignedNodes();
    if (assigned.length) return Array.from(assigned);
  }
  return Array.from(el.childNodes);
}

function visit(node: Node, out: AriaNode[], state: WalkState, parentCursor: string) {
  if (state.count > NODE_LIMIT) return;
  if (node.nodeType === 3) {
    const text = node.nodeValue ?? "";
    if (!text || state.inLabel) return;
    if (state.openText) {
      state.openText.text += text;
    } else if (text.trim()) {
      state.openText = { role: "text", text };
      out.push(state.openText);
      state.count++;
    }
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.localName;
  if (SKIPPED.has(tag) || el.getAttribute("aria-hidden") === "true") return;

  const style = getComputedStyle(el);
  if (style.display === "none" || style.contentVisibility === "hidden") return;
  // A hidden element's child may be `visibility: visible`
  const hidden = style.visibility !== "visible";

  const block = isBlock(style);
  const cursor = style.cursor;

  let role = hidden ? "" : roleOf(el);
  if (INLINE_TEXT_ROLES.has(role) && !el.hasAttribute("role")) role = "";

  const focusable =
    !hidden &&
    !role &&
    (el.hasAttribute("tabindex") && (el as HTMLElement).tabIndex >= 0);
  const pointer = !hidden && cursor === "pointer" && parentCursor !== "pointer";
  const clickable = !hidden && !role && (pointer || el.hasAttribute("onclick"));
  const generic = !role && (focusable || clickable);

  if (!role && !generic) {
    // Nothing to say about this element itself: its content belongs to the parent
    if (block) state.openText = null;
    const wasInLabel = state.inLabel;
    if (tag === "label" && (el as HTMLLabelElement).control) state.inLabel = true;
    for (const child of children(el)) visit(child, out, state, cursor);
    state.inLabel = wasInLabel;
    if (block) state.openText = null;
    return;
  }

  state.openText = null;
  state.count++;
  const item: AriaNode = { role: role || "generic", ref: refFor(el) };
  const name = role ? accessibleName(el) : "";
  if (name) item.name = name;

  if (tag === "a" || tag === "area") {
    const href = el.getAttribute("href");
    if (href && !/^javascript:/i.test(href)) item.url = href;
  }
  const level = levelOf(el);
  if (level !== undefined && role === "heading") item.level = level;
  const checked = checkedState(el);
  if (checked !== undefined) item.checked = checked;
  const pressed = pressedState(el);
  if (pressed !== undefined) item.pressed = pressed;
  const expanded = expandedState(el);
  if (expanded !== undefined) item.expanded = expanded;
  const selected = selectedState(el);
  if (selected) item.selected = true;
  if (role && isDisabled(el)) item.disabled = true;
  if (el.matches(":required") || el.getAttribute("aria-required") === "true") {
    item.required = true;
  }
  if (el.getAttribute("aria-readonly") === "true" || (el as HTMLInputElement).readOnly === true) {
    item.readonly = true;
  }
  if (el.getAttribute("aria-invalid") === "true") item.invalid = true;
  if (el === state.active && el !== document.body) item.active = true;
  if (generic && pointer) item.cursor = "pointer";
  if (["slider", "spinbutton", "progressbar", "meter"].includes(role)) {
    const value =
      el.getAttribute("aria-valuetext") ??
      el.getAttribute("aria-valuenow") ??
      (el as HTMLInputElement).value;
    if (value !== undefined && value !== null && value !== "") {
      item.value = String(value);
    }
  }
  const value = fieldValue(el);
  if (value !== undefined) item.text = value;
  out.push(item);

  if (role === "iframe") {
    const frameId = browser.runtime.getFrameId(el);
    if (typeof frameId === "number" && frameId >= 0) item.frameId = frameId;
    return;
  }
  if (LEAF_TAGS.has(tag)) return;
  // An editing host's content is its value
  if (role === "textbox") {
    const text = (el.textContent ?? "").trim();
    if (text) item.text = text;
    return;
  }
  if (tag === "details" && !(el as HTMLDetailsElement).open) {
    const summary = el.querySelector(":scope > summary");
    const kept: AriaNode[] = [];
    if (summary) visit(summary, kept, state, cursor);
    state.openText = null;
    if (kept.length) item.children = kept;
    return;
  }
  const kids: AriaNode[] = [];
  const wasInLabel = state.inLabel;
  state.inLabel = false;
  for (const child of children(el)) visit(child, kids, state, cursor);
  state.inLabel = wasInLabel;
  state.openText = null;
  if (kids.length) item.children = kids;
}

/** Trims the text, and folds a lone text child into its parent's line */
function tidy(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  for (const node of nodes) {
    if (node.role === "text") {
      const text = (node.text ?? "").replace(/\s+/g, " ").trim();
      if (text) out.push({ role: "text", text });
      continue;
    }
    if (node.children) {
      const kids = tidy(node.children);
      const onlyText = kids.length > 0 && kids.every((kid) => kid.role === "text");
      if (onlyText) {
        const text = kids.map((kid) => kid.text).join(" ");
        // A link's or button's text is its name already
        if (nameComesFromContent(node.role) && node.name) {
          delete node.children;
        } else if (node.text === undefined) {
          node.text = text;
          delete node.children;
        } else {
          node.children = kids;
        }
      } else if (kids.length) {
        node.children = kids;
      } else {
        delete node.children;
      }
    }
    out.push(node);
  }
  return out;
}

export function snapshot(): { nodes: AriaNode[]; doc: string; truncated: boolean } {
  pruneRefs();
  const state: WalkState = {
    count: 0,
    active: deepActiveElement(),
    openText: null,
    inLabel: false,
  };
  const out: AriaNode[] = [];
  const root = document.documentElement;
  if (root) {
    for (const child of children(root)) visit(child, out, state, "");
  }
  return {
    nodes: tidy(out),
    doc: DOC_ID,
    truncated: state.count > NODE_LIMIT,
  };
}

/** DOM helpers that see through shadow roots, closed ones too: Firefox gives content scripts `openOrClosedShadowRoot` */

export function shadowOf(el: Element): ShadowRoot | null {
  return (
    (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null })
      .openOrClosedShadowRoot ?? null
  );
}

/** The parent element, crossing out of a shadow root to its host */
export function composedParent(node: Node): Element | null {
  const parent = node.parentNode;
  if (!parent) return null;
  if (parent.nodeType === 11) return (parent as ShadowRoot).host ?? null;
  return parent.nodeType === 1 ? (parent as Element) : null;
}

/** Every element under `root` in document order, descending into shadow roots */
export function* deepElements(root: ParentNode): Generator<Element> {
  for (const child of Array.from(root.children)) {
    yield child;
    const shadow = shadowOf(child);
    if (shadow) yield* deepElements(shadow);
    yield* deepElements(child);
  }
}

export function deepContains(ancestor: Element, node: Node | null): boolean {
  for (let current = node; current; current = composedParent(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

export function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el) {
    const inner = shadowOf(el)?.activeElement;
    if (!inner) break;
    el = inner;
  }
  return el;
}

export function deepElementFromPoint(x: number, y: number): Element | null {
  let hit = document.elementFromPoint(x, y);
  while (hit) {
    const inner = shadowOf(hit)?.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  return hit;
}

/** Rendered with a size and not `visibility: hidden` */
export function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "contents") {
    return Array.from(el.children).some(isVisible);
  }
  if (style.visibility !== "visible" || !el.checkVisibility()) return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** `<button#save>`, for messages to the agent */
export function describeElement(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const className = el.getAttribute("class")?.trim();
  const cls = !id && className ? `.${className.split(/\s+/)[0]}` : "";
  return `<${el.localName}${id}${cls}>`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

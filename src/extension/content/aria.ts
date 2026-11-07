/**
 * Roles, accessible names and states, computed from the DOM. Firefox has no API that gives an extension the browser's
 * own accessibility tree, so this follows the ARIA and accname rules closely enough for agents to find things by what
 * users see. It's a simplification: names don't include CSS generated content, for one.
 */
import { composedParent, normalizeText, shadowOf } from "./dom";

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  image: "button",
  reset: "button",
  submit: "button",
  file: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  number: "spinbutton",
  search: "searchbox",
};

const TAG_ROLES: Record<string, string> = {
  article: "article",
  aside: "complementary",
  blockquote: "blockquote",
  button: "button",
  caption: "caption",
  code: "code",
  datalist: "listbox",
  dd: "definition",
  details: "group",
  dfn: "term",
  dialog: "dialog",
  dt: "term",
  fieldset: "group",
  figure: "figure",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  h4: "heading",
  h5: "heading",
  h6: "heading",
  hr: "separator",
  iframe: "iframe",
  frame: "iframe",
  li: "listitem",
  main: "main",
  math: "math",
  menu: "list",
  meter: "meter",
  nav: "navigation",
  ol: "list",
  optgroup: "group",
  option: "option",
  output: "status",
  p: "paragraph",
  progress: "progressbar",
  search: "search",
  summary: "button",
  table: "table",
  tbody: "rowgroup",
  textarea: "textbox",
  tfoot: "rowgroup",
  thead: "rowgroup",
  tr: "row",
  ul: "list",
};

/** Header and footer are landmarks only outside these */
const SECTIONING = new Set(["article", "aside", "main", "nav", "section"]);

const NAME_FROM_CONTENT = new Set([
  "button",
  "cell",
  "checkbox",
  "columnheader",
  "gridcell",
  "heading",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "row",
  "rowheader",
  "switch",
  "tab",
  "tooltip",
  "treeitem",
]);

function closestComposed(el: Element, tags: Set<string>): Element | null {
  for (let p = composedParent(el); p; p = composedParent(p)) {
    if (tags.has(p.localName)) return p;
  }
  return null;
}

function implicitRole(el: Element): string {
  const tag = el.localName;
  // Tag names come from the page, and <constructor> is one
  const role = Object.hasOwn(TAG_ROLES, tag) ? TAG_ROLES[tag] : undefined;
  if (role) return role;
  switch (tag) {
    case "a":
    case "area":
      return el.hasAttribute("href") ? "link" : "";
    case "form":
      return hasOwnLabel(el) ? "form" : "";
    case "section":
      return hasOwnLabel(el) ? "region" : "";
    case "header":
      return closestComposed(el, SECTIONING) ? "" : "banner";
    case "footer":
      return closestComposed(el, SECTIONING) ? "" : "contentinfo";
    case "img":
      return el.getAttribute("alt") === "" && !el.hasAttribute("title")
        ? ""
        : "img";
    case "svg":
      return hasOwnLabel(el) || el.querySelector(":scope > title") ? "img" : "";
    case "td": {
      const table = closestComposed(el, new Set(["table"]));
      return table?.getAttribute("role") === "grid" ? "gridcell" : "cell";
    }
    case "th": {
      const scope = el.getAttribute("scope");
      if (scope === "row" || scope === "rowgroup") return "rowheader";
      if (scope === "col" || scope === "colgroup") return "columnheader";
      // Without a scope: a header in a body row with other cells heads its row
      const row = el.parentElement;
      const inBody = row?.parentElement?.localName === "tbody";
      const onlyHeaders = !row?.querySelector(":scope > td");
      return inBody && !onlyHeaders ? "rowheader" : "columnheader";
    }
    case "select": {
      const select = el as HTMLSelectElement;
      return select.multiple || select.size > 1 ? "listbox" : "combobox";
    }
    case "input": {
      const input = el as HTMLInputElement;
      if (input.type === "hidden") return "";
      if (input.list) return "combobox";
      return INPUT_ROLES[input.type] ?? "textbox";
    }
  }
  if ((el as HTMLElement).isContentEditable && isEditingHost(el)) {
    return "textbox";
  }
  return "";
}

function isEditingHost(el: Element): boolean {
  const value = el.getAttribute("contenteditable");
  return value !== null && value.toLowerCase() !== "false";
}

function hasOwnLabel(el: Element): boolean {
  return !!(
    el.getAttribute("aria-label")?.trim() ||
    el.getAttribute("aria-labelledby")?.trim()
  );
}

/** The element's role, or `""` for one that means nothing to assistive technology (a plain `div`, `role=none`) */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0]?.toLowerCase();
  if (explicit) {
    if (explicit === "none" || explicit === "presentation") {
      // Focusable elements keep their role whatever the author says
      return (el as HTMLElement).tabIndex >= 0 ? implicitRole(el) : "";
    }
    return explicit;
  }
  return implicitRole(el);
}

export function labelsOf(el: Element): Element[] {
  const labels = (el as HTMLInputElement).labels;
  return labels ? Array.from(labels) : [];
}

function byId(el: Element, id: string): Element | null {
  const root = el.getRootNode() as Document | ShadowRoot;
  return root.getElementById?.(id) ?? null;
}

/** Elements `aria-labelledby` points at */
export function labelledBy(el: Element): Element[] {
  const ids = el.getAttribute("aria-labelledby")?.trim();
  if (!ids) return [];
  return ids
    .split(/\s+/)
    .map((id) => byId(el, id))
    .filter((found): found is Element => !!found);
}

function isHiddenForName(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return true;
  const style = getComputedStyle(el);
  return style.display === "none" || style.visibility === "hidden";
}

/** The text a subtree contributes to a name */
function textOf(
  el: Element,
  visited: Set<Element>,
  includeHidden: boolean,
): string {
  const parts: string[] = [];
  const shadow = shadowOf(el);
  const children: Node[] =
    el.localName === "slot" && (el as HTMLSlotElement).assignedNodes().length
      ? Array.from((el as HTMLSlotElement).assignedNodes())
      : Array.from((shadow ?? el).childNodes);
  for (const child of children) {
    if (child.nodeType === 3) {
      parts.push(child.nodeValue ?? "");
    } else if (child.nodeType === 1) {
      const element = child as Element;
      if (!includeHidden && isHiddenForName(element)) continue;
      const display = getComputedStyle(element).display;
      const inline = display === "inline" || display === "contents";
      const text = nameOf(element, visited, includeHidden, true);
      parts.push(inline ? text : ` ${text} `);
    }
  }
  return parts.join("");
}

function nameOf(
  el: Element,
  visited: Set<Element>,
  includeHidden: boolean,
  embedded: boolean,
): string {
  if (visited.has(el)) return "";
  visited.add(el);

  if (!embedded) {
    const sources = labelledBy(el);
    if (sources.length) {
      const text = sources
        .map((source) => nameOf(source, visited, true, true))
        .join(" ");
      if (normalizeText(text)) return text;
    }
  }
  const label = el.getAttribute("aria-label");
  if (label?.trim()) return label;

  const tag = el.localName;
  const role = roleOf(el);

  // A control inside a label contributes its value
  if (embedded && (tag === "input" || tag === "textarea" || tag === "select")) {
    const type = (el as HTMLInputElement).type;
    if (tag === "select") {
      const selected = (el as HTMLSelectElement).selectedOptions[0];
      return selected?.textContent ?? "";
    }
    if (!["button", "submit", "reset", "image"].includes(type)) {
      return type === "password" ? "" : (el as HTMLInputElement).value;
    }
  }

  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (["button", "submit", "reset"].includes(input.type)) {
      return (
        input.value ||
        (input.type === "submit"
          ? "Submit"
          : input.type === "reset"
            ? "Reset"
            : "")
      );
    }
    if (input.type === "image") {
      return input.alt || input.title || "Submit";
    }
  }
  if (tag === "input" || tag === "textarea" || tag === "select") {
    const labels = labelsOf(el);
    if (labels.length) {
      const text = labels
        .map((item) => textOf(item, visited, includeHidden))
        .join(" ");
      if (normalizeText(text)) return text;
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder?.trim()) return placeholder;
    return el.getAttribute("title") ?? "";
  }
  if (tag === "img" || tag === "area") {
    return el.getAttribute("alt") || el.getAttribute("title") || "";
  }
  if (tag === "svg") {
    const title = el.querySelector(":scope > title");
    return title?.textContent ?? el.getAttribute("title") ?? "";
  }
  if (tag === "fieldset") {
    const legend = el.querySelector(":scope > legend");
    if (legend) return textOf(legend, visited, includeHidden);
  }
  if (tag === "table") {
    const caption = el.querySelector(":scope > caption");
    if (caption) return textOf(caption, visited, includeHidden);
  }
  if (tag === "figure") {
    const caption = el.querySelector(":scope > figcaption");
    if (caption) return textOf(caption, visited, includeHidden);
  }
  if (tag === "details") {
    const summary = el.querySelector(":scope > summary");
    if (summary) return textOf(summary, visited, includeHidden);
  }

  if (embedded || NAME_FROM_CONTENT.has(role)) {
    const text = textOf(el, visited, includeHidden);
    if (normalizeText(text)) return text;
  }
  return el.getAttribute("title") ?? "";
}

const NAME_LIMIT = 500;

export function accessibleName(el: Element): string {
  const name = normalizeText(nameOf(el, new Set(), false, false));
  return name.length > NAME_LIMIT ? `${name.slice(0, NAME_LIMIT - 1)}…` : name;
}

export function nameComesFromContent(role: string): boolean {
  return NAME_FROM_CONTENT.has(role);
}

function triState(value: string | null): boolean | "mixed" | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "mixed") return "mixed";
  return undefined;
}

export function checkedState(el: Element): boolean | "mixed" | undefined {
  const aria = triState(el.getAttribute("aria-checked"));
  if (aria !== undefined) return aria;
  if (el.localName === "input") {
    const input = el as HTMLInputElement;
    if (input.type === "checkbox" || input.type === "radio") {
      return input.indeterminate ? "mixed" : input.checked;
    }
  }
  return undefined;
}

export function pressedState(el: Element): boolean | "mixed" | undefined {
  return triState(el.getAttribute("aria-pressed"));
}

export function expandedState(el: Element): boolean | undefined {
  const aria = el.getAttribute("aria-expanded");
  if (aria === "true") return true;
  if (aria === "false") return false;
  if (el.localName === "details") return (el as HTMLDetailsElement).open;
  return undefined;
}

export function selectedState(el: Element): boolean | undefined {
  if (el.localName === "option") return (el as HTMLOptionElement).selected;
  const aria = el.getAttribute("aria-selected");
  return aria === "true" ? true : aria === "false" ? false : undefined;
}

export function isDisabled(el: Element): boolean {
  if (el.matches(":disabled")) return true;
  for (let node: Element | null = el; node; node = composedParent(node)) {
    if (node.getAttribute("aria-disabled") === "true") return true;
  }
  return false;
}

export function levelOf(el: Element): number | undefined {
  const aria = Number(el.getAttribute("aria-level"));
  if (aria > 0) return aria;
  const heading = /^h([1-6])$/.exec(el.localName);
  return heading ? Number(heading[1]) : undefined;
}

/** Renders the extension's accessibility tree as `- role "name" [ref=e1]: text` lines, and filters it */
import type { AriaNode } from "../protocol";

const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "option",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "spinbutton",
  "treeitem",
]);

const LANDMARKS = new Set([
  "banner",
  "main",
  "navigation",
  "contentinfo",
  "complementary",
  "region",
  "form",
  "search",
  "dialog",
  "alertdialog",
]);

const CELLS = new Set(["cell", "gridcell", "columnheader", "rowheader"]);

/** Dropped by `-i` when unnamed, keeping their children */
const LAYOUT = new Set([
  "generic",
  "rowgroup",
  "paragraph",
  "group",
  "table",
  "list",
  "article",
  "figure",
  "blockquote",
]);

/** Kept by `-i` when they hold more than one kept child, so related elements stay together */
const GROUPS = new Set(["row", "listitem"]);

function isKept(node: AriaNode): boolean {
  if (INTERACTIVE.has(node.role) || node.cursor === "pointer") return true;
  if (LANDMARKS.has(node.role)) return !!node.name || node.role === "main";
  if (CELLS.has(node.role)) return !!(node.name || node.text);
  return node.role === "heading" || node.role === "iframe";
}

/** `-i`: interactive elements, landmarks, headings and cells, with what holds them */
export function interactiveOnly(nodes: AriaNode[]): AriaNode[] {
  const out: AriaNode[] = [];
  // What's next to a control with no name of its own is all that says what it's for
  const nearby = nodes
    .filter((node) => node.role === "text")
    .map((node) => node.text)
    .join(" ");
  for (const node of nodes) {
    if (node.role === "text") continue;
    const children = interactiveOnly(node.children ?? []);
    const kept = isKept(node);
    if (!kept && children.length === 0) continue;
    const wrapper =
      !node.name &&
      (LAYOUT.has(node.role) ||
        CELLS.has(node.role) ||
        (GROUPS.has(node.role) && children.length === 1));
    if (!kept && wrapper) {
      out.push(...children);
      continue;
    }
    const { text, children: _unused, ...rest } = node;
    const copy: AriaNode = { ...rest };
    if (kept && text !== undefined) copy.text = text;
    else if (kept && !node.name && nearby && INTERACTIVE.has(node.role)) copy.text = shorten(nearby, 80);
    if (!kept && node.name) copy.name = shorten(node.name, 80);
    if (children.length) copy.children = children;
    out.push(copy);
  }
  return out;
}

export function findByRef(nodes: AriaNode[], ref: string): AriaNode | undefined {
  for (const node of nodes) {
    if (node.ref === ref) return node;
    const found = findByRef(node.children ?? [], ref);
    if (found) return found;
  }
  return undefined;
}

/** State shown in brackets, in this order */
const ATTRIBUTES = ["level", "checked", "pressed", "expanded", "selected", "disabled", "required", "readonly", "invalid", "active", "value", "url"] as const;

export function nodeLine(node: AriaNode): string {
  if (node.role === "text") return `text: ${node.text ?? ""}`;
  let line = node.role;
  if (node.name) line += ` ${JSON.stringify(node.name)}`;
  for (const key of ATTRIBUTES) {
    const value = node[key];
    if (value === undefined || value === false) continue;
    line += value === true ? ` [${key}]` : ` [${key}=${String(value)}]`;
  }
  if (node.ref) line += ` [ref=${node.ref}]`;
  if (node.cursor === "pointer") line += " [cursor=pointer]";
  if (node.text) line += `: ${node.text}`;
  return line;
}

export function render(nodes: AriaNode[], depth = Infinity): string {
  const lines: string[] = [];
  const walk = (list: AriaNode[], level: number) => {
    for (const node of list) {
      const children = node.children ?? [];
      const cut = level + 1 >= depth && children.length > 0;
      lines.push(`${"  ".repeat(level)}- ${nodeLine(node)}${cut ? " …" : children.length ? ":" : ""}`);
      if (!cut) walk(children, level + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
}

function pathLabel(node: AriaNode): string | undefined {
  if (node.name) return `${node.role} ${JSON.stringify(shorten(node.name, 40))}`;
  if (LANDMARKS.has(node.role)) return node.role;
  return undefined;
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Each node whose name, text or URL contains the text (ignoring case), with its ancestors */
export function find(nodes: AriaNode[], query: string): string[] {
  const needle = query.toLowerCase();
  const contains = (value: string | undefined) => !!value && value.toLowerCase().includes(needle);
  const matches: string[] = [];
  const walk = (list: AriaNode[], path: string[]) => {
    for (const node of list) {
      const children = node.children ?? [];
      if (node.role === "text") {
        // Text belongs to its parent, whose line was handled below
        continue;
      }
      const textChild = children.some((child) => child.role === "text" && contains(child.text));
      if (contains(node.name) || contains(node.text) || contains(node.url) || textChild) {
        const text = textChild
          ? children
              .filter((child) => child.role === "text")
              .map((child) => child.text)
              .join(" ")
          : undefined;
        const line = nodeLine(text && !node.text ? { ...node, text } : node);
        matches.push(path.length ? `${path.join(" > ")} > ${line}` : line);
      }
      const label = pathLabel(node);
      walk(children, label ? [...path, label] : path);
    }
  };
  walk(nodes, []);
  // Text at the top level of the page has no parent line
  for (const node of nodes) {
    if (node.role === "text" && contains(node.text)) matches.push(nodeLine(node));
  }
  return matches;
}

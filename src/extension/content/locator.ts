/**
 * Evaluates targets in the page: Playwright-style locators (`getByRole('button', { name: 'Go' })`) and CSS, both of
 * which reach into shadow roots. The daemon parses locators into a list of calls, so nothing here evaluates code.
 */
import type { Literal, LocatorCall, Target } from "../../protocol";
import {
  accessibleName,
  checkedState,
  expandedState,
  isDisabled,
  labelledBy,
  labelsOf,
  levelOf,
  pressedState,
  roleOf,
  selectedState,
} from "./aria";
import {
  composedParent,
  deepElements,
  isVisible,
  normalizeText,
  shadowOf,
} from "./dom";

type Matcher = (text: string) => boolean;

export class LocatorError extends Error {}

function isRegex(arg: Literal | undefined): arg is { regex: string; flags: string } {
  return typeof arg === "object" && arg !== null && "regex" in arg;
}

function optionsOf(arg: Literal | undefined): Record<string, unknown> {
  return typeof arg === "object" && arg !== null && !isRegex(arg)
    ? (arg as Record<string, unknown>)
    : {};
}

function matcherFor(value: unknown, exact = false): Matcher {
  if (isRegex(value as Literal)) {
    const { regex, flags } = value as { regex: string; flags: string };
    const pattern = new RegExp(regex, flags.replace("g", ""));
    return (text) => pattern.test(text);
  }
  const wanted = normalizeText(String(value));
  if (exact) return (text) => text === wanted;
  const lower = wanted.toLowerCase();
  return (text) => text.toLowerCase().includes(lower);
}

const NOT_TEXT = new Set(["script", "style", "noscript", "template", "head", "title", "meta", "link"]);

function ownText(el: Element): string {
  if (el.localName === "input") {
    const input = el as HTMLInputElement;
    if (["button", "submit", "reset"].includes(input.type)) return input.value;
    return "";
  }
  let text = el.textContent ?? "";
  // Slotted and shadow text isn't in textContent
  const shadow = shadowOf(el);
  if (shadow) text += ` ${shadow.textContent ?? ""}`;
  return normalizeText(text);
}

/** Elements whose text matches, the innermost ones only */
function byText(scope: Element | Document, matches: Matcher): Element[] {
  const found: Element[] = [];
  const root = scope.nodeType === 9 ? (scope as Document).documentElement : (scope as Element);
  if (!root) return found;
  for (const el of allWithin(root)) {
    if (NOT_TEXT.has(el.localName) || el.localName === "html" || el.localName === "body") continue;
    if (!matches(ownText(el))) continue;
    const childMatches = Array.from(el.children).some(
      (child) => !NOT_TEXT.has(child.localName) && matches(ownText(child)),
    );
    const shadow = shadowOf(el);
    const shadowMatches =
      !!shadow &&
      Array.from(shadow.children).some(
        (child) => !NOT_TEXT.has(child.localName) && matches(ownText(child)),
      );
    if (!childMatches && !shadowMatches) found.push(el);
  }
  return found;
}

function allWithin(scope: ParentNode): Element[] {
  return Array.from(deepElements(scope));
}

function isHiddenFromAria(el: Element): boolean {
  for (let node: Element | null = el; node; node = composedParent(node)) {
    if (node.getAttribute("aria-hidden") === "true") return true;
    const style = getComputedStyle(node);
    if (style.display === "none") return true;
    if (node === el && style.visibility !== "visible") return true;
  }
  return false;
}

function byRole(scope: ParentNode, role: string, options: Record<string, unknown>): Element[] {
  const nameMatches =
    options.name !== undefined
      ? matcherFor(options.name, options.exact === true)
      : null;
  return allWithin(scope).filter((el) => {
    if (roleOf(el) !== role) return false;
    if (!options.includeHidden && isHiddenFromAria(el)) return false;
    if (nameMatches && !nameMatches(accessibleName(el))) return false;
    if (options.checked !== undefined && (checkedState(el) === true) !== options.checked) return false;
    if (options.pressed !== undefined && (pressedState(el) === true) !== options.pressed) return false;
    if (options.expanded !== undefined && expandedState(el) !== options.expanded) return false;
    if (options.selected !== undefined && (selectedState(el) === true) !== options.selected) return false;
    if (options.disabled !== undefined && isDisabled(el) !== options.disabled) return false;
    if (options.level !== undefined && levelOf(el) !== options.level) return false;
    return true;
  });
}

function byLabel(scope: ParentNode, matches: Matcher): Element[] {
  return allWithin(scope).filter((el) => {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && matches(normalizeText(ariaLabel))) return true;
    const sources = [...labelledBy(el), ...labelsOf(el)];
    return sources.some((source) => matches(normalizeText(source.textContent ?? "")));
  });
}

function byAttribute(scope: ParentNode, attribute: string, matches: Matcher): Element[] {
  return allWithin(scope).filter((el) => {
    const value = el.getAttribute(attribute);
    return value !== null && matches(normalizeText(value));
  });
}

function deepQuery(scope: ParentNode, selector: string): Element[] {
  let found: Element[];
  try {
    found = Array.from(scope.querySelectorAll(selector));
  } catch {
    throw new LocatorError(
      `${selector} isn't a valid target. Use a ref, a locator such as getByRole('button', { name: 'Submit' }), or a CSS selector`,
    );
  }
  for (const el of allWithin(scope)) {
    const shadow = shadowOf(el);
    if (shadow) found.push(...shadow.querySelectorAll(selector));
  }
  return found;
}

function applyCall(current: ParentNode[], call: LocatorCall): ParentNode[] {
  const { method, args } = call;
  const flatMap = (fn: (scope: ParentNode) => Element[]) => {
    const seen = new Set<Element>();
    for (const scope of current) {
      for (const el of fn(scope)) seen.add(el);
    }
    return Array.from(seen);
  };
  const options = optionsOf(args[1]);
  const text = () => matcherFor(args[0], options.exact === true);
  switch (method) {
    case "getByRole":
      return flatMap((scope) => byRole(scope, String(args[0]), options));
    case "getByText":
      return flatMap((scope) => byText(scope as Element | Document, text()));
    case "getByLabel":
      return flatMap((scope) => byLabel(scope, text()));
    case "getByPlaceholder":
      return flatMap((scope) => byAttribute(scope, "placeholder", text()));
    case "getByAltText":
      return flatMap((scope) => byAttribute(scope, "alt", text()));
    case "getByTitle":
      return flatMap((scope) => byAttribute(scope, "title", text()));
    case "getByTestId":
      return flatMap((scope) => byAttribute(scope, "data-testid", matcherFor(args[0], true)));
    case "locator": {
      const found = flatMap((scope) => deepQuery(scope, String(args[0])));
      return applyFilter(found, options);
    }
    case "filter":
      return applyFilter(current as Element[], optionsOf(args[0]));
    case "first":
      return current.slice(0, 1);
    case "last":
      return current.slice(-1);
    case "nth": {
      const index = Number(args[0]);
      const el = index < 0 ? current[current.length + index] : current[index];
      return el ? [el] : [];
    }
    default:
      throw new LocatorError(`${method}() isn't supported`);
  }
}

function applyFilter(elements: Element[], options: Record<string, unknown>): Element[] {
  let out = elements;
  if (options.hasText !== undefined) {
    const matches = matcherFor(options.hasText);
    out = out.filter((el) => matches(ownText(el)));
  }
  if (options.hasNotText !== undefined) {
    const matches = matcherFor(options.hasNotText);
    out = out.filter((el) => !matches(ownText(el)));
  }
  if (options.visible !== undefined) {
    out = out.filter((el) => isVisible(el) === options.visible);
  }
  return out;
}

export function runLocator(calls: LocatorCall[]): Element[] {
  let current: ParentNode[] = [document];
  for (const call of calls) current = applyCall(current, call);
  return current as Element[];
}

/** Elements for a locator or CSS target. Refs are resolved by the caller */
export function query(target: Exclude<Target, { kind: "ref" }>): Element[] {
  if (target.kind === "css") return deepQuery(document, target.selector);
  return runLocator(target.calls);
}

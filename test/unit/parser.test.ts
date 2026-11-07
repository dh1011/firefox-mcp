import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ParseError, parseArgs, parseCommands, tokenize } from "../../src/server/parser";
import { parseLocator, parseTarget } from "../../src/server/targets";

const texts = (line: string) => tokenize(line).map((token) => token.text);

describe("parseCommands", () => {
  it("numbers lines, skipping blanks and comments", () => {
    assert.deepEqual(parseCommands("goto x\n\n# note\r\nclick y"), [
      { step: 1, source: "goto x" },
      { step: 2, source: "click y" },
    ]);
  });
});

describe("tokenize", () => {
  it("splits on spaces and honors quotes", () => {
    assert.deepEqual(texts('fill #a "hello world"'), ["fill", "#a", "hello world"]);
    assert.deepEqual(texts("fill #a 'it\\'s'"), ["fill", "#a", "it's"]);
  });

  it("decodes JSON escapes", () => {
    assert.deepEqual(texts('type "two\\nlines \\"quoted\\""'), ["type", 'two\nlines "quoted"']);
  });

  it("keeps eval's code verbatim, but for its own quote", () => {
    assert.deepEqual(texts('eval "x => /\\d+/.test(x) && \\"a\\""'), ["eval", 'x => /\\d+/.test(x) && "a"']);
  });

  it("keeps Windows paths for the commands that take files", () => {
    assert.deepEqual(texts('upload #f "C:\\new\\table.txt"'), ["upload", "#f", "C:\\new\\table.txt"]);
    assert.deepEqual(texts('screenshot --path "C:\\Users\\a.jpg"'), ["screenshot", "--path", "C:\\Users\\a.jpg"]);
  });

  it("keeps locators whole, with spaces and nested quotes", () => {
    assert.deepEqual(texts("click getByRole('button', { name: 'Go on' }).first() --force"), [
      "click",
      "getByRole('button', { name: 'Go on' }).first()",
      "--force",
    ]);
    assert.deepEqual(texts('click a[title="x y"]'), ["click", 'a[title="x y"]']);
    assert.deepEqual(texts("click getByRole('link', { name: /a b(c)/i })"), ["click", "getByRole('link', { name: /a b(c)/i })"]);
  });

  it("reports mistakes by column, without echoing the text", () => {
    assert.throws(() => tokenize('fill #a "secret'), (error: Error) => {
      assert.ok(error instanceof ParseError);
      assert.match(error.message, /column 9/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
    assert.throws(() => tokenize("click getByRole('a'"), /Unbalanced brackets/);
  });
});

describe("parseArgs", () => {
  const args = (line: string, spec: Record<string, boolean>) => parseArgs("x", tokenize(line).slice(1), spec);

  it("separates flags and positionals", () => {
    const parsed = args("x a --max 5 -i b", { max: true, i: false });
    assert.deepEqual(parsed.positional.map((token) => token.text), ["a", "b"]);
    assert.deepEqual(parsed.flags, { max: "5", i: true });
  });

  it("treats quoted flags as text", () => {
    assert.deepEqual(args('x "--submit"', { submit: false }).positional.map((token) => token.text), ["--submit"]);
  });

  it("rejects unknown flags and missing values", () => {
    assert.throws(() => args("x --nope", {}), /no --nope flag/);
    assert.throws(() => args("x --max", { max: true }), /--max needs a value/);
  });
});

describe("parseTarget", () => {
  it("recognizes refs, locators and CSS", () => {
    assert.equal(parseTarget("e12").kind, "ref");
    assert.equal(parseTarget("f1e3").kind, "ref");
    assert.equal(parseTarget("getByText('x')").kind, "locator");
    assert.equal(parseTarget("page.getByText('x')").kind, "locator");
    assert.equal(parseTarget("#go").kind, "css");
    assert.equal(parseTarget("button.primary").kind, "css");
  });
});

describe("parseLocator", () => {
  it("parses chains, options and regexes into JSON-safe calls", () => {
    assert.deepEqual(parseLocator("getByRole('button', { name: /sub/i, exact: true }).nth(2)"), [
      { method: "getByRole", args: ["button", { name: { regex: "sub", flags: "i" }, exact: true }] },
      { method: "nth", args: [2] },
    ]);
    const calls = parseLocator("frameLocator('#f').getByLabel(\"Email\")");
    assert.deepEqual(calls.map((call) => call.method), ["frameLocator", "getByLabel"]);
    JSON.stringify(calls);
  });

  it("only takes literals and known methods, so nothing can run", () => {
    assert.throws(() => parseLocator("getByRole(alert(1))"), /expected a string/);
    assert.throws(() => parseLocator("evil('x')"), /evil\(\) isn't supported/);
    assert.throws(() => parseLocator("getByText('a').constructor('x')"), /constructor\(\) isn't supported/);
    assert.throws(() => parseLocator("getByText(`${x}`)"), /template expressions/);
    assert.throws(() => parseLocator("getByText('x', { nope: 1 })"), /no nope option/);
    assert.throws(() => parseLocator("getByRole('a', { name: { x: 1 } })"), /nested objects/);
    assert.throws(() => parseLocator("getByText('x"), /missing closing quote/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AriaNode } from "../../src/protocol";
import { find, findByRef, interactiveOnly, nodeLine, render } from "../../src/server/snapshot";

const TREE: AriaNode[] = [
  {
    role: "navigation",
    name: "Main",
    ref: "e1",
    children: [{ role: "link", name: "Home", ref: "e2", url: "/" }],
  },
  {
    role: "main",
    ref: "e3",
    children: [
      { role: "heading", name: "Title", level: 1, ref: "e4" },
      { role: "paragraph", ref: "e5", text: "Some text" },
      {
        role: "list",
        ref: "e6",
        children: [
          { role: "listitem", ref: "e7", children: [{ role: "button", name: "One", ref: "e8", disabled: true }] },
        ],
      },
      { role: "text", text: "loose text" },
    ],
  },
];

describe("nodeLine", () => {
  it("shows the name, state, ref and text", () => {
    assert.equal(
      nodeLine({ role: "checkbox", name: "Agree", checked: true, ref: "e1" }),
      'checkbox "Agree" [checked] [ref=e1]',
    );
    assert.equal(nodeLine({ role: "textbox", name: "Name", ref: "e2", text: "Ada" }), 'textbox "Name" [ref=e2]: Ada');
    assert.equal(nodeLine({ role: "checkbox", checked: "mixed", ref: "e3" }), "checkbox [checked=mixed] [ref=e3]");
    assert.equal(nodeLine({ role: "text", text: "hi" }), "text: hi");
    assert.equal(nodeLine({ role: "button", name: 'Say "hi"', ref: "e4", expanded: false }), 'button "Say \\"hi\\"" [ref=e4]');
  });
});

describe("render", () => {
  it("indents children", () => {
    const text = render(TREE);
    assert.match(text, /^- navigation "Main" \[ref=e1\]:\n {2}- link "Home" \[url=\/\] \[ref=e2\]/);
  });

  it("cuts below a depth", () => {
    const text = render(TREE, 1);
    assert.equal(text, '- navigation "Main" [ref=e1] …\n- main [ref=e3] …');
  });
});

describe("interactiveOnly", () => {
  it("keeps what can be acted on and headings, dropping wrappers and text", () => {
    const text = render(interactiveOnly(TREE));
    assert.match(text, /link "Home"/);
    assert.match(text, /heading "Title"/);
    assert.match(text, /button "One"/);
    assert.doesNotMatch(text, /Some text/);
    assert.doesNotMatch(text, /loose text/);
    assert.doesNotMatch(text, /- list/);
    assert.doesNotMatch(text, /listitem/);
  });

  it("says what a control with no name is next to", () => {
    const nodes: AriaNode[] = [
      {
        role: "listitem",
        ref: "e1",
        children: [
          { role: "checkbox", ref: "e2" },
          { role: "text", text: "Buy milk" },
        ],
      },
    ];
    assert.equal(render(interactiveOnly(nodes)), "- checkbox [ref=e2]: Buy milk");
  });
});

describe("findByRef", () => {
  it("searches the whole tree", () => {
    assert.equal(findByRef(TREE, "e8")?.name, "One");
    assert.equal(findByRef(TREE, "e99"), undefined);
  });
});

describe("find", () => {
  it("matches names, text and URLs, ignoring case, with ancestors", () => {
    assert.deepEqual(find(TREE, "HOME"), ['navigation "Main" > link "Home" [url=/] [ref=e2]']);
    assert.deepEqual(find(TREE, "some text"), ["main > paragraph [ref=e5]: Some text"]);
    assert.deepEqual(find(TREE, "nothing"), []);
  });

  it("finds text that sits directly under an element", () => {
    assert.match(find(TREE, "loose")[0] ?? "", /main \[ref=e3\]: loose text/);
  });
});

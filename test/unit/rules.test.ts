import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isExposedUrl, safeHeaders } from "../../src/extension/background/rules";
import { normalizeUrl } from "../../src/server/commands";
import { cap, capTail, readCap, READ_CAP, READ_CAP_MAX } from "../../src/server/output";
import { compareVersions } from "../../src/server/version";

describe("isExposedUrl", () => {
  it("allows web pages and about:blank", () => {
    for (const url of ["https://example.com/", "http://localhost:3000/x", "http://127.0.0.1/", "about:blank"]) {
      assert.equal(isExposedUrl(url), true, url);
    }
  });

  it("refuses browser pages, extension pages, local files and script URLs", () => {
    for (const url of [
      "about:config",
      "about:debugging#/runtime/this-firefox",
      "about:addons",
      "about:home",
      "about:blank#x",
      "moz-extension://abc/popup.html",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "view-source:https://example.com",
      "chrome://browser/content/browser.xhtml",
      "resource://gre/",
      "not a url",
      "",
      undefined,
    ]) {
      assert.equal(isExposedUrl(url), false, String(url));
    }
  });

  it("refuses the sites Firefox doesn't let extensions script", () => {
    assert.equal(isExposedUrl("https://addons.mozilla.org/en-US/firefox/"), false);
    assert.equal(isExposedUrl("https://accounts.firefox.com/"), false);
    assert.equal(isExposedUrl("https://mozilla.org/"), true);
  });
});

describe("safeHeaders", () => {
  it("hides credentials, whatever their case", () => {
    assert.deepEqual(
      safeHeaders([
        { name: "Accept", value: "*/*" },
        { name: "Cookie", value: "session=abc" },
        { name: "AUTHORIZATION", value: "Bearer abc" },
        { name: "set-cookie", value: "a=b" },
        { name: "X-CSRF-Token", value: "abc" },
      ]),
      [
        ["Accept", "*/*"],
        ["Cookie", "(hidden)"],
        ["AUTHORIZATION", "(hidden)"],
        ["set-cookie", "(hidden)"],
        ["X-CSRF-Token", "(hidden)"],
      ],
    );
    assert.deepEqual(safeHeaders(undefined), []);
  });
});

describe("normalizeUrl", () => {
  it("adds a scheme where it's missing", () => {
    assert.equal(normalizeUrl("example.com"), "https://example.com");
    assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
    assert.equal(normalizeUrl("127.0.0.1:8080/x"), "http://127.0.0.1:8080/x");
    assert.equal(normalizeUrl("https://example.com"), "https://example.com");
    assert.equal(normalizeUrl("about:blank"), "about:blank");
  });
});

describe("output caps", () => {
  it("reads --max", () => {
    assert.equal(readCap(undefined), READ_CAP);
    assert.equal(readCap("all"), READ_CAP_MAX);
    assert.equal(readCap("500"), 500);
    assert.equal(readCap(String(READ_CAP_MAX * 2)), READ_CAP_MAX);
    assert.throws(() => readCap("lots"), /--max takes/);
    assert.throws(() => readCap("-1"), /--max takes/);
  });

  it("cuts at a line break and says how to read more", () => {
    const text = `${"a".repeat(90)}\n${"b".repeat(90)}`;
    const out = cap(text, 100);
    assert.match(out, /^a{90}\n… cut at 90 of 181 characters: --max all reads all of it/);
    assert.equal(cap("short", 100), "short");
  });

  it("keeps a log's end", () => {
    const out = capTail("old line\nnew line", 10);
    assert.match(out, /new line$/);
    assert.match(out, /earlier characters cut/);
  });
});

describe("compareVersions", () => {
  it("orders by number, ignoring the build", () => {
    assert.ok(compareVersions("0.2.0", "0.1.9") > 0);
    assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
    assert.equal(compareVersions("0.1.0+abc", "0.1.0+def"), 0);
    assert.ok(compareVersions("0.1.0", "0.1.1") < 0);
  });
});

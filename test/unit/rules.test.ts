import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isExposedUrl, safeHeaders, safePostData, safeUrl } from "../../src/extension/background/rules";
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

  it("refuses them with a trailing dot too, which is the same site", () => {
    for (const url of [
      "https://addons.mozilla.org./",
      "https://accounts.firefox.com./settings",
      "https://ADDONS.MOZILLA.ORG../",
      "https://addons.mozilla.org.:443/",
    ]) {
      assert.equal(isExposedUrl(url), false, url);
    }
    assert.equal(isExposedUrl("https://example.com./"), true);
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

  it("hides the credentials sites name themselves", () => {
    const names = [
      "Proxy-Authorization",
      "Set-Cookie2",
      "X-XSRF-TOKEN",
      "x-csrftoken",
      "X-Api-Key",
      "x-goog-api-key",
      "X-Auth-Token",
      "X-Amz-Security-Token",
      "X-Session-Id",
      "X-Access-Key",
      "x-client-secret",
      "X-Auth",
    ];
    for (const name of names) {
      assert.deepEqual(safeHeaders([{ name, value: "s3cret" }]), [[name, "(hidden)"]], name);
    }
  });

  it("keeps the headers that help with debugging", () => {
    const kept = [
      ["Content-Type", "application/json"],
      ["Content-Security-Policy", "default-src 'self'"],
      ["Sec-Fetch-Mode", "cors"],
      ["Keep-Alive", "timeout=5"],
      ["WWW-Authenticate", 'Bearer realm="api"'],
      ["Access-Control-Allow-Credentials", "true"],
      ["Access-Control-Allow-Headers", "authorization"],
    ] as [string, string][];
    assert.deepEqual(safeHeaders(kept.map(([name, value]) => ({ name, value }))), kept);
  });

  it("hides credentials in the URLs headers carry", () => {
    assert.deepEqual(
      safeHeaders([
        { name: "Referer", value: "https://example.com/cb?code=abc&state=xyz" },
        { name: "Location", value: "/done?access_token=abc#id_token=def" },
      ]),
      [
        ["Referer", "https://example.com/cb?code=(hidden)&state=xyz"],
        ["Location", "/done?access_token=(hidden)#id_token=(hidden)"],
      ],
    );
  });
});

describe("safeUrl", () => {
  it("hides parameters named like credentials, and keeps the rest exactly as it was", () => {
    assert.equal(
      safeUrl("https://example.com/api?q=a%20b+c&access_token=URLTOK&api_key=K&X-Amz-Signature=S&page=2"),
      "https://example.com/api?q=a%20b+c&access_token=(hidden)&api_key=(hidden)&X-Amz-Signature=(hidden)&page=2",
    );
    assert.equal(safeUrl("https://example.com/?user%5Bpassword%5D=x&flag"), "https://example.com/?user%5Bpassword%5D=(hidden)&flag");
    assert.equal(safeUrl("https://example.com/cb#access_token=abc&token_type=bearer"), "https://example.com/cb#access_token=(hidden)&token_type=(hidden)");
  });

  it("hides a password before the host", () => {
    assert.equal(safeUrl("https://ada:hunter2@example.com:8443/x?y=1"), "https://ada:(hidden)@example.com:8443/x?y=1");
    assert.equal(safeUrl("https://example.com:8443/a@b"), "https://example.com:8443/a@b");
  });

  it("leaves URLs with nothing to hide alone", () => {
    for (const url of ["https://example.com/", "https://example.com/search?q=token+limits", "https://example.com/#section", "about:blank"]) {
      assert.equal(safeUrl(url), url);
    }
  });
});

describe("safePostData", () => {
  const raw = (text: string) => ({ raw: [{ bytes: new TextEncoder().encode(text).buffer }] });

  it("hides form fields named like credentials", () => {
    assert.equal(
      safePostData({ formData: { email: ["ada@example.com"], password: ["hunter2"], csrfmiddlewaretoken: ["t"] } }, 1000),
      "email=ada@example.com&password=(hidden)&csrfmiddlewaretoken=(hidden)",
    );
  });

  it("hides JSON keys at any depth, and keeps JSON with nothing to hide as it was sent", () => {
    assert.equal(
      safePostData(raw('{"user":{"name":"ada","password":"hunter2"},"items":[{"apiKey":"k","n":1}]}'), 1000),
      '{"user":{"name":"ada","password":"(hidden)"},"items":[{"apiKey":"(hidden)","n":1}]}',
    );
    assert.equal(safePostData(raw('{ "q": 1 }'), 1000), '{ "q": 1 }');
  });

  it("hides fields of URL-encoded bodies sent as bytes", () => {
    assert.equal(safePostData(raw("grant_type=refresh_token&refresh_token=abc&client_secret=def"), 1000), "grant_type=refresh_token&refresh_token=(hidden)&client_secret=(hidden)");
  });

  it("returns nothing for requests without a body", () => {
    assert.equal(safePostData(undefined, 1000), undefined);
    assert.equal(safePostData({}, 1000), undefined);
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

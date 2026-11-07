/** Drives real Firefox through the real MCP server, the way an AI app does */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import WebSocket from "ws";

import { type Fixtures, startFixtures } from "./fixtures";
import { Firefox, freePort, McpApp, ServerHome, waitUntil } from "./harness";

let firefox: Firefox;
let fixtures: Fixtures;
let home: ServerHome;
let app: McpApp;
let files: string;

/** Whatever the page's `log()` last said */
const status = () => app.ok("get text #status").then((text) => text.split("\n").at(-1) ?? "");

function refOf(snapshotText: string, line: RegExp): string {
  const match = snapshotText.split("\n").find((item) => line.test(item));
  assert.ok(match, `No line matches ${line} in:\n${snapshotText}`);
  const ref = /\[ref=(\w+)\]/.exec(match)?.[1];
  assert.ok(ref, `No ref in: ${match}`);
  return ref;
}

async function open(url = "/") {
  await app.ok(`goto ${fixtures.base}${url}`);
}

before(async () => {
  fixtures = await startFixtures();
  files = mkdtempSync(path.join(tmpdir(), "firefox-mcp-files-"));
  const port = await freePort();
  home = new ServerHome(port);
  firefox = await Firefox.launch();
  await firefox.setPort(port);
  app = await McpApp.start(home.dir, port);
});

after(async () => {
  await app?.close().catch(() => {});
  await home?.remove();
  await firefox?.close();
  await fixtures?.close();
  rmSync(files, { recursive: true, force: true });
});

describe("the MCP surface", () => {
  it("offers one tool, and instructions", async () => {
    const tools = await app.tools();
    assert.deepEqual(tools.map((tool) => tool.name), ["browser"]);
    assert.match(tools[0]!.description ?? "", /Firefox/);
    assert.match(app.instructions() ?? "", /snapshot -i/);
  });

  it("answers help with no browser involved", async () => {
    assert.match(await app.ok("help"), /goto <url>/);
    assert.match(await app.ok("help dialog"), /BEFORE the step/);
  });
});

describe("pairing", () => {
  it("refuses everything until the user clicks Allow, showing the same code on both sides", async () => {
    const refused = await app.fails("tab list");
    const code = /code (\d{3} \d{3})/.exec(refused)?.[1];
    assert.ok(code, `No code in: ${refused}`);
    const shown = await waitUntil(async () => {
      const text = await firefox.popupText("code");
      return text.includes("Code:") ? text : "";
    }, "the popup to show the code");
    assert.equal(shown, `Code: ${code}`);
    await firefox.clickInPopup("allow");
    await waitUntil(async () => !(await app.run("tab list")).isError, "the pairing to take effect");
    await waitUntil(async () => (await firefox.popupText("status")) === "Connected", "the popup to catch up");
  });

  it("keeps the pairing when the daemon restarts", async () => {
    await home.stopDaemon();
    // The next call starts a new daemon, the extension reconnects, and no one has to click again
    const text = await waitUntil(async () => {
      const result = await app.run("tab list");
      return result.isError ? "" : result.text;
    }, "the extension to reconnect", 20_000);
    assert.ok(text);
    await waitUntil(async () => (await firefox.popupText("status")) === "Connected", "the popup to catch up");
  });
});

describe("what the daemon refuses", () => {
  const upgrade = (urlPath: string, headers: Record<string, string>) =>
    new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${home.port}${urlPath}`, { headers });
      socket.on("open", () => {
        socket.terminate();
        resolve("open");
      });
      socket.on("unexpected-response", (_request, response) => resolve(String(response.statusCode)));
      socket.on("error", () => resolve("error"));
    });

  it("a web page connecting as the extension", async () => {
    assert.equal(await upgrade("/extension", { Origin: "https://evil.example" }), "403");
    assert.equal(await upgrade("/extension", {}), "403");
  });

  it("a client without the token, or from a page", async () => {
    const { token } = home.info()!;
    assert.equal(await upgrade("/client", {}), "403");
    assert.equal(await upgrade("/client?token=wrong", {}), "403");
    assert.equal(await upgrade(`/client?token=${token}`, { Origin: "https://evil.example" }), "403");
  });

  it("DNS rebinding, by the Host header", async () => {
    assert.equal(await upgrade("/extension", { Host: "evil.example", Origin: "moz-extension://abc-123" }), "403");
    const response = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${home.port}/client`, { headers: { Host: "evil.example" } });
      socket.on("unexpected-response", (_request, res) => resolve(res.statusCode ?? 0));
      socket.on("error", () => resolve(0));
    });
    assert.equal(response, 403);
  });

  it("shutting it down without the token", async () => {
    const response = await fetch(`http://127.0.0.1:${home.port}/shutdown?token=wrong`, { method: "POST" });
    assert.equal(response.status, 403);
  });

  it("gives pages no way to read its status", async () => {
    const response = await fetch(`http://127.0.0.1:${home.port}/firefox-mcp/status`);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });
});

describe("tabs", () => {
  it("opens a background tab of its own on the first goto", async () => {
    const text = await app.ok(`goto ${fixtures.base}/\ntab list`);
    const mine = text.split("\n").find((line) => line.startsWith("*"));
    assert.ok(mine, text);
    assert.match(mine, /\(yours\)/, "It's the agent's and not the active tab");
    assert.doesNotMatch(mine, /active/);
    assert.match(mine, /"Kitchen sink"/);
  });

  it("leaves out browser pages", async () => {
    const text = await app.ok("tab list");
    assert.doesNotMatch(text, /about:/);
    assert.doesNotMatch(text, /moz-extension:/);
  });

  it("won't go to browser pages, extension pages or local files", async () => {
    for (const url of ["about:config", "about:debugging", "file:///C:/Windows/win.ini", "moz-extension://abc/popup.html", "javascript:alert(1)", "https://addons.mozilla.org/"]) {
      assert.match(await app.fails(`goto ${url}`), /Agents can't use/, url);
    }
  });

  it("opens, selects and closes tabs, closing only its own", async () => {
    const created = await app.ok(`tab new ${fixtures.base}/second`);
    const id = Number(/tab (\d+)/.exec(created)?.[1]);
    assert.ok(id);
    assert.match(await app.ok("get title"), /Second/);
    await app.ok(`tab close ${id}`);
    assert.match(await app.fails("get title"), /no current tab/);
    assert.match(await app.fails("tab close 999999"), /isn't one you opened/);
    await open();
  });

  it("reports a closed tab rather than failing oddly", async () => {
    const created = await app.ok("tab new");
    const id = Number(/tab (\d+)/.exec(created)?.[1]);
    await app.ok("tab close");
    assert.doesNotMatch(await app.ok("tab list"), new RegExp(`^. ${id} `, "m"));
  });
});

describe("snapshots", () => {
  it("shows roles, names and state, with refs", async () => {
    await open();
    const text = await app.ok("snapshot --max all");
    assert.match(text, /heading "Kitchen sink" \[level=1\] \[ref=e\d+\]/);
    assert.match(text, /navigation "Main"/);
    assert.match(text, /link "Second page" \[url=\/second\?from=link\] \[ref=e\d+\]/);
    assert.match(text, /button "Go" \[ref=e\d+\]/);
    assert.match(text, /button "Disabled one" \[disabled\]/);
    assert.match(text, /textbox "Name"/);
    assert.match(text, /textbox "Email"/);
    assert.match(text, /spinbutton "Age"/);
    assert.match(text, /checkbox "I agree" \[ref=e\d+\]/);
    assert.match(text, /radio "Small"/);
    assert.match(text, /combobox "Country"/);
    assert.match(text, /option "Canada"/);
    assert.match(text, /listbox "Many"/);
    assert.match(text, /img "A tiny image"/);
    assert.match(text, /table "Scores"/);
    assert.match(text, /columnheader "Who"/);
    assert.match(text, /rowheader "Ann"/);
    assert.match(text, /cell "9"/);
    assert.match(text, /listitem/);
    assert.match(text, /generic \[ref=e\d+\] \[cursor=pointer\]: A clickable div/);
    assert.match(text, /paragraph .*Some bold text in a paragraph/);
  });

  it("leaves out what's hidden", async () => {
    const text = await app.ok("snapshot --max all");
    assert.doesNotMatch(text, /Hidden one/);
    assert.doesNotMatch(text, /Details body/);
    assert.doesNotMatch(text, /In a modal/);
    assert.match(text, /group "More" \[expanded=false\]|group "More"/);
  });

  it("includes shadow roots, closed ones too", async () => {
    const text = await app.ok("snapshot --max all");
    assert.match(text, /button "Open shadow button"/);
    assert.match(text, /button "Closed shadow button"/);
  });

  it("includes iframes, cross-origin ones too, with their own refs", async () => {
    const text = await app.ok("snapshot --max all");
    assert.match(text, /iframe "Same origin" \[ref=e\d+\]:/);
    assert.match(text, /button "Frame button same" \[ref=f\d+e\d+\]/);
    assert.match(text, /button "Frame button other" \[ref=f\d+e\d+\]/);
  });

  it("narrows with -i, --depth and a target, without changing refs", async () => {
    const full = await app.ok("snapshot --max all");
    const interactive = await app.ok("snapshot -i");
    assert.ok(interactive.length < full.length);
    assert.equal(refOf(full, /button "Go"/), refOf(interactive, /button "Go"/));
    assert.doesNotMatch(interactive, /Some bold text/);
    assert.match(await app.ok("snapshot --depth 1"), /…/);
    const scoped = await app.ok("snapshot getByRole('navigation')");
    assert.match(scoped, /Second page/);
    assert.doesNotMatch(scoped, /Kitchen sink/);
  });

  it("finds lines with their ancestors", async () => {
    const text = await app.ok('find "second page"');
    assert.match(text, /navigation "Main" > link "Second page"/);
    assert.match(await app.ok('find "no such thing here"'), /No matches/);
  });

  it("masks passwords", async () => {
    await app.ok('fill #password "hunter2"');
    const text = await app.ok("snapshot --max all");
    assert.doesNotMatch(text, /hunter2/);
    assert.match(text, /textbox "Password" .*: ••••/);
  });

  it("caps long output and says how to get more", async () => {
    const text = await app.ok("snapshot --max 200");
    assert.match(text, /cut at \d+ of \d+ characters/);
  });
});

describe("clicking", () => {
  it("clicks by ref, locator and CSS", async () => {
    await open();
    const text = await app.ok("snapshot -i");
    await app.ok(`click ${refOf(text, /button "Go"/)}`);
    assert.match(await status(), /clicked/);
    await open();
    await app.ok("click getByRole('button', { name: 'Go' })");
    assert.match(await status(), /clicked/);
    await open();
    await app.ok("click #go");
    assert.match(await status(), /clicked/);
    await open();
    await app.ok("click getByText('A clickable div')");
    assert.equal(await status(), "div clicked");
  });

  it("is honest that clicks are synthetic", async () => {
    await open();
    await app.ok("click #go");
    assert.equal(await status(), "clicked trusted=false");
  });

  it("supports double and right clicks", async () => {
    await open();
    await app.ok("click #dbl --double");
    assert.equal(await status(), "double");
    await app.ok("click #ctx --button right");
    assert.equal(await status(), "context");
  });

  it("scrolls far elements into view", async () => {
    await open();
    await app.ok("click #far");
    assert.equal(await status(), "far clicked");
  });

  it("refuses what a user couldn't click, and says why", async () => {
    await open();
    assert.match(await app.fails("click getByRole('button', { name: 'Disabled one' })"), /is disabled/);
    assert.match(await app.fails("click 'button[style*=none]'"), /isn't visible/);
    assert.match(await app.fails("click .dup"), /matched 2 elements/);
    assert.match(await app.fails("click #nothing-here"), /Nothing matches/);
  });

  it("names what covers an element, and --force overrides it", async () => {
    await open();
    await app.ok("click getByRole('button', { name: 'Show overlay' })");
    assert.match(await app.fails("click #behind"), /covered by `<div#overlay>`/);
    await app.ok("click #behind --force");
    assert.equal(await status(), "behind clicked");
  });

  it("clicks in shadow roots, closed ones too", async () => {
    await open();
    await app.ok("click getByRole('button', { name: 'Open shadow button' })");
    assert.equal(await status(), "open shadow clicked");
    const text = await app.ok("snapshot -i");
    await app.ok(`click ${refOf(text, /Closed shadow button/)}`);
    assert.equal(await status(), "closed shadow clicked");
  });

  it("clicks in iframes by ref and through frameLocator", async () => {
    await open();
    const text = await app.ok("snapshot -i");
    await app.ok(`click ${refOf(text, /Frame button other/)}`);
    assert.match(await app.ok("snapshot --max all"), /button "Clicked in other"/);
    await app.ok("click frameLocator('#same').getByRole('button', { name: 'Frame button same' })");
    assert.match(await app.ok("snapshot --max all"), /button "Clicked in same"/);
  });

  it("finds a locator in an iframe without being told", async () => {
    await open();
    await app.ok("fill getByLabel('Frame field other') \"typed in a frame\"");
    assert.equal(await app.ok("get value getByLabel('Frame field other')").then((t) => t.split("\n").at(-1)), "typed in a frame");
  });
});

describe("typing in frames", () => {
  it("sends keys to the frame that has focus, and back to the page after", async () => {
    await open();
    await app.ok(`click frameLocator('#cross').getByLabel('Frame field other')\ntype "into the frame"`);
    assert.match(await app.ok("get value frameLocator('#cross').getByLabel('Frame field other')"), /into the frame/);
    await app.ok(`press Backspace`);
    assert.match(await app.ok("get value frameLocator('#cross').getByLabel('Frame field other')"), /into the fram$/);
    await app.ok('click #name\ntype "in the page"');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "in the page");
  });
});

describe("typing", () => {
  it("fills fields with trusted input events, in a background tab", async () => {
    await open();
    await app.ok('fill #name "Ada"');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "Ada");
    const events = await app.ok('eval "() => window.events"');
    assert.match(events, /name input trusted=true/);
  });

  it("doesn't echo typed text", async () => {
    const text = await app.ok('fill #password "s3cret-value"');
    assert.doesNotMatch(text, /s3cret-value/);
    const broken = await app.fails('fill #nothing-here "s3cret-value"');
    assert.doesNotMatch(broken, /s3cret-value/);
  });

  it("replaces what was there, and clears", async () => {
    await open();
    await app.ok('fill #name "first"\nfill #name "second"');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "second");
    await app.ok('fill #name ""');
    assert.equal((await app.ok('eval "() => document.getElementById(\'name\').value"')).split("\n").at(-1), '""');
  });

  it("handles each kind of field", async () => {
    await open();
    await app.ok('fill #email "a@b.co"\nfill #age "42"\nfill #when "2026-01-02"\nfill #volume "7"\nfill #notes "two\\nlines"');
    const value = async (selector: string) => (await app.ok(`get value ${selector}`)).split("\n").slice(1).join("\n");
    assert.equal(await value("#email"), "a@b.co");
    assert.equal(await value("#age"), "42");
    assert.equal(await value("#when"), "2026-01-02");
    assert.equal(await value("#volume"), "7");
    assert.equal(await value("#notes"), "two\nlines");
  });

  it("works with a React-style value tracker", async () => {
    await open();
    await app.ok('fill #tracked "controlled"');
    assert.equal(await status(), "tracked change controlled");
  });

  it("fills contenteditable editors through trusted beforeinput", async () => {
    await open();
    await app.ok('fill #editor "rich text"');
    assert.match((await app.ok("get text #editor")), /rich text/);
    assert.match(await app.ok('eval "() => window.events"'), /editor beforeinput trusted=true/);
    await app.ok('fill #editor "replaced"');
    const text = await app.ok("get text #editor");
    assert.match(text, /replaced/);
    assert.doesNotMatch(text, /rich text/);
  });

  it("types into the focused element, and refuses with nothing focused", async () => {
    await open();
    assert.match(await app.fails('type "lost"'), /Nothing editable is focused/);
    await app.ok('click #name\ntype "by typing"');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "by typing");
    await app.ok('type " slowly" --slowly');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "by typing slowly");
    await app.ok('click #editor\ntype "into editor"');
    assert.match(await app.ok("get text #editor"), /into editor/);
  });

  it("submits with --submit and Enter", async () => {
    await open();
    await app.ok('fill #name "Grace" --submit');
    assert.equal(await status(), "submitted Grace");
    await open();
    await app.ok('fill #name "Linus"\npress Enter');
    assert.equal(await status(), "submitted Linus");
  });
});

describe("keys", () => {
  it("moves focus with Tab", async () => {
    await open();
    await app.ok("click #name\npress Tab");
    assert.match(await app.ok('eval "() => document.activeElement.id"'), /email/);
    await app.ok("press Shift+Tab");
    assert.match(await app.ok('eval "() => document.activeElement.id"'), /name/);
  });

  it("edits with Backspace, Delete, arrows and select-all", async () => {
    await open();
    await app.ok('fill #name "abcd"\npress Backspace');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "abc");
    await app.ok("press Home\npress Delete");
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "bc");
    await app.ok('press End\npress ArrowLeft\ntype "X"');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "bXc");
    await app.ok('press Control+a\ntype "all"');
    assert.equal((await app.ok("get value #name")).split("\n").at(-1), "all");
  });

  it("activates buttons with Enter and Space, and toggles with Space", async () => {
    await open();
    await app.ok('eval "() => document.getElementById(\'go\').focus()"\npress Enter');
    assert.match(await status(), /clicked/);
    await app.ok('eval "() => document.getElementById(\'agree\').focus()"\npress Space');
    assert.equal(await status(), "agree true");
  });

  it("closes a modal dialog with Escape, and sees inside it while open", async () => {
    await open();
    await app.ok("click getByRole('button', { name: 'Open modal' })");
    assert.match(await app.ok("snapshot --max all"), /In a modal/);
    await app.ok("press Escape");
    assert.doesNotMatch(await app.ok("snapshot --max all"), /In a modal/);
  });

  it("rejects what isn't a key", async () => {
    assert.match(await app.fails("press NotAKey"), /isn't a key/);
    assert.match(await app.fails("press Hyper+a"), /isn't a modifier/);
  });
});

describe("forms", () => {
  it("checks and unchecks, including a box hidden behind its label", async () => {
    await open();
    await app.ok("check #agree");
    assert.equal(await status(), "agree true");
    assert.match(await app.ok("check #agree"), /already checked/);
    await app.ok("uncheck #agree");
    assert.equal(await status(), "agree false");
    await app.ok("check #fancy");
    assert.match(await app.ok('eval "() => document.getElementById(\'fancy\').checked"'), /true/);
    await app.ok("check getByRole('radio', { name: 'Large' })");
    assert.match(await app.ok("snapshot --max all"), /radio "Large" \[checked\]/);
    assert.match(await app.fails("check #go"), /isn't a checkbox/);
  });

  it("selects by value and label, and clicking an option works too", async () => {
    await open();
    await app.ok('select #country "jp"');
    assert.equal(await status(), "country jp");
    await app.ok('select #country "Canada"');
    assert.equal(await status(), "country ca");
    assert.match(await app.fails('select #country "Mars"'), /No option .* matches .* It has: "Pick", "Canada", "Japan"/);
    await app.ok('select #many "Alpha" "Gamma"');
    assert.match(await app.ok('eval "() => Array.from(document.getElementById(\'many\').selectedOptions).map(o => o.value)"'), /\["a","c"\]/);
    const text = await app.ok("snapshot -i");
    await app.ok(`click ${refOf(text, /option "Japan"/)}`);
    assert.equal(await status(), "country jp");
  });

  it("uploads files, also through a picker the page opens itself", async () => {
    await open();
    const file = path.join(files, "hello.txt");
    writeFileSync(file, "hello there");
    const second = path.join(files, "two.bin");
    writeFileSync(second, Buffer.from([1, 2, 3]));
    await app.ok(`upload #upload "${file}" "${second}"`);
    assert.equal(await status(), "files hello.txt:11,two.bin:3");
    await app.ok(`upload #pick "${file}"`);
    assert.equal(await status(), "picked hello.txt");
    assert.match(await app.fails(`upload #go "${file}"`), /didn't open a file picker/);
    assert.match(await app.fails(`upload #upload "${path.join(files, "missing.txt")}"`), /ENOENT|no such file/);
  });
});

describe("navigation", () => {
  it("waits for a navigation a click starts, and notes the new URL", async () => {
    await open();
    const text = await app.ok("click getByRole('link', { name: 'Second page' })\nget text getByRole('heading')");
    assert.match(text, /→ \/second\?from=link/);
    assert.match(text, /Second page/);
    assert.match(await app.ok("get text #query"), /from=link/);
  });

  it("goes back, forward and reloads", async () => {
    await open();
    await app.ok("click getByRole('link', { name: 'Second page' })");
    await app.ok("back");
    assert.match(await app.ok("get title"), /Kitchen sink/);
    await app.ok("forward");
    assert.match(await app.ok("get title"), /Second/);
    await app.ok("reload");
    assert.match(await app.ok("get title"), /Second/);
  });

  it("says when there's no page to go back to", async () => {
    await app.ok(`tab new ${fixtures.base}/second`);
    assert.match(await app.fails("forward"), /no page to go forward/);
    await app.ok("tab close");
    await open();
  });

  it("fails stale refs after a navigation rather than hitting another element", async () => {
    await open();
    const text = await app.ok("snapshot -i");
    const ref = refOf(text, /button "Go"/);
    await app.ok(`goto ${fixtures.base}/second`);
    assert.match(await app.fails(`click ${ref}`), /isn't on the page anymore/);
    await open();
    assert.match(await app.fails(`click ${ref}`), /isn't on the page anymore/);
  });

  it("follows redirects, and reports where it landed", async () => {
    assert.match(await app.ok(`goto ${fixtures.base}/redirect`), /→ .*\/second\?from=redirect/);
  });

  it("reports a page that can't load", async () => {
    const dead = await freePort();
    assert.match(await app.fails(`goto http://127.0.0.1:${dead}/`), /Couldn't load the page: the connection was refused/);
    assert.match(await app.fails("goto http://nonexistent-host.invalid/"), /Couldn't load the page: the server wasn't found/);
    // Firefox refuses this port without reporting a network error at all
    assert.match(await app.fails("goto http://127.0.0.1:1/"), /Couldn't load the page: .*port/);
    await open();
    const text = await app.ok(`eval "() => { location.href = 'http://127.0.0.1:${dead}/'; }"`);
    assert.match(text, /the page it opened didn't load: the connection was refused/);
    await open();
  });

  it("isn't held up by a navigation that goes nowhere", async () => {
    await open();
    const started = Date.now();
    const text = await app.ok(`eval "() => { location.href = '/empty'; }"`);
    assert.ok(Date.now() - started < 3000, `Took ${Date.now() - started} ms`);
    assert.doesNotMatch(text, /still loading/);
    assert.match(await app.ok("get title"), /Kitchen sink/);
    const gotoEmpty = Date.now();
    await app.ok(`goto ${fixtures.base}/empty`);
    assert.ok(Date.now() - gotoEmpty < 3000, `Took ${Date.now() - gotoEmpty} ms`);
  });

  it("waits for slow pages", async () => {
    await app.ok(`goto ${fixtures.base}/slow`);
    assert.match(await app.ok("get text"), /Slow page/);
    await open();
  });
});

describe("waiting", () => {
  it("waits for text, its absence, a target and a URL", async () => {
    await open();
    await app.ok("click getByRole('button', { name: 'Later' })\nwait --text \"Arrived late\"");
    await app.ok('wait --gone "This never was here"');
    await app.ok("wait #late");
    await app.ok('wait --url "**/127.0.0.1*/**"');
    await app.ok("wait 10");
  });

  it("times out with a clear message", async () => {
    assert.match(await app.fails('wait --text "never appears" --timeout 200'), /Timed out after 200 ms waiting for the text "never appears"/);
  });
});

describe("reading", () => {
  it("reads text, values, counts, attributes, the URL and title", async () => {
    await open();
    assert.match(await app.ok("get text getByRole('heading')"), /Kitchen sink/);
    assert.match(await app.ok("get text"), /Some bold text/);
    assert.match(await app.ok("get count .dup"), /\n2$/);
    assert.match(await app.ok("get count getByRole('button', { name: 'Same', exact: true })"), /\n2$/);
    assert.match(await app.ok("get attr id getByRole('button', { name: 'Go' })"), /\ngo$/);
    assert.match(await app.ok("get attr nope #go"), /\(none\)/);
    assert.match(await app.ok("get url"), new RegExp(fixtures.base));
    assert.match(await app.ok("get title"), /Kitchen sink/);
  });

  it("supports the locator methods", async () => {
    await open();
    assert.match(await app.ok("get value getByPlaceholder('you@example.com')"), /✓/);
    assert.match(await app.ok("get attr id getByLabel('Email')"), /email/);
    assert.match(await app.ok("get attr alt getByAltText('A tiny image')"), /A tiny image/);
    await app.ok("click getByRole('button', { name: 'Same' }).first()");
    await app.ok("click getByRole('button', { name: 'Same' }).nth(1)");
    await app.ok("click getByRole('button', { name: /^same$/i }).last()");
    await app.ok("click locator('button').filter({ hasText: 'Double me' })");
    assert.match(await app.ok("get count getByRole('heading', { level: 1 })"), /\n1$/);
    assert.match(await app.ok("get count getByRole('button', { name: 'Go', exact: true })"), /\n1$/);
    assert.match(await app.ok("get count getByRole('checkbox', { checked: false })"), /\n[1-9]/);
  });

  it("refuses locators that aren't literal", async () => {
    assert.match(await app.fails("click getByRole(alert(1))"), /Can't parse the locator/);
    assert.match(await app.fails("click evil('x')"), /evil\(\) isn't supported/);
  });
});

describe("eval", () => {
  it("runs functions and expressions in the page, async too", async () => {
    await open();
    assert.match(await app.ok('eval "() => document.title"'), /"Kitchen sink"/);
    assert.match(await app.ok('eval "document.title.length"'), /12/);
    assert.match(await app.ok('eval "async () => { await new Promise(r => setTimeout(r, 10)); return {a: [1, 2]}; }"'), /\{"a":\[1,2\]\}/);
    assert.match(await app.ok('eval "() => undefined"'), /undefined/);
    assert.match(await app.ok('eval "() => typeof window.log"'), /"function"/, "It sees the page's variables");
  });

  it("passes a target to the function", async () => {
    assert.match(await app.ok('eval "el => el.id" #go'), /"go"/);
  });

  it("lets slow code take its time", async () => {
    assert.match(await app.ok('eval "async () => { await new Promise(r => setTimeout(r, 9000)); return \'done\'; }"'), /"done"/);
  });

  it("reports errors thrown in the page", async () => {
    assert.match(await app.fails('eval "() => { throw new TypeError(\'bad thing\'); }"'), /bad thing/);
  });

  it("falls back to the isolated world under a strict CSP, and says so", async () => {
    await open("/csp");
    const text = await app.ok('eval "() => document.title"');
    assert.match(text, /"Strict"/);
    assert.match(text, /isolated world/);
    assert.match(await app.ok('eval "() => window.wrappedJSObject.fromPage"'), /"page variable"/);
    assert.match(await app.ok('eval "el => el.textContent" getByRole(\'heading\')'), /Strict page/);
    assert.match(await app.ok("snapshot"), /heading "Strict page"/);
  });

  it("gives code in the isolated world no way to the extension's controls", async () => {
    await open("/csp");
    const reach = await app.ok(
      'eval "() => [typeof browser, typeof chrome, typeof globalThis.browser, typeof window.browser, typeof window.wrappedJSObject.browser]"',
    );
    assert.match(reach, /isolated world/);
    assert.match(reach, /\["undefined","undefined","undefined","undefined","undefined"\]/);
    // Loading the script again, as a new frame or a retry does, doesn't bring them back or break it
    await app.ok("reload");
    assert.match(await app.ok("snapshot"), /heading "Strict page"/);
    await waitUntil(async () => /Connected/.test(await firefox.popupText("status")), "the popup to say it's still connected");
  });
});

describe("console and requests", () => {
  it("captures console messages from the first script on, and uncaught errors", async () => {
    await open();
    await app.ok("click getByRole('button', { name: 'Log things' })");
    await app.ok("click getByRole('button', { name: 'Throw' })\nwait 200");
    const text = await app.ok("console");
    assert.match(text, /\[log\] early log from head/);
    assert.match(text, /\[log\] a log \{"a":1\}/);
    assert.match(text, /\[warn\] a warning/);
    assert.match(text, /\[error\] an error/);
    assert.match(text, /\[uncaught\] .*thrown in timer/);
    const errors = await app.ok("console --errors");
    assert.doesNotMatch(errors, /a warning/);
    assert.match(errors, /an error/);
  });

  it("notes new console errors on the step that caused them", async () => {
    await open();
    const text = await app.ok("click getByRole('button', { name: 'Log things' })");
    assert.match(text, /1 new console error: an error/);
  });

  it("keeps messages across navigations", async () => {
    await open();
    await app.ok(`goto ${fixtures.base}/second`);
    assert.match(await app.ok("console"), /second page loaded/);
  });

  it("lists requests and shows their details, hiding credentials", async () => {
    await open();
    await app.ok("click getByRole('button', { name: 'Fetch' })\nwait --text \"fetched 42\"");
    const list = await app.ok('requests --filter "/api/data"');
    const id = /#(\d+) POST 200 .*\/api\/data/.exec(list)?.[1];
    assert.ok(id, list);
    const detail = await app.ok(`request ${id} --body`);
    assert.match(detail, /POST .*\/api\/data/);
    assert.match(detail, /Post data:\n\{"q":1\}/);
    assert.match(detail, /Status: HTTP\/1\.1 200 OK/);
    assert.match(detail, /Body:\n\{"value":42\}/);
    assert.match(detail, /authorization: \(hidden\)/i);
    assert.match(detail, /set-cookie: \(hidden\)/i);
    assert.doesNotMatch(detail, /SECRET/);
    assert.match(await app.ok("requests"), /document|GET 200/);
    assert.match(await app.fails("request 99999"), /No request #99999/);
  });

  it("doesn't break the page while reading responses", async () => {
    assert.equal(await status(), "fetched 42");
  });
});

describe("dialogs", () => {
  it("acknowledges alerts and says so", async () => {
    await open();
    const text = await app.ok("click getByRole('button', { name: 'Alert' })");
    assert.match(text, /alert "Hello alert" answered: OK/);
    assert.equal(await status(), "alert returned undefined");
  });

  it("dismisses unannounced confirms, and tells the agent how to accept", async () => {
    await open();
    const text = await app.ok("click getByRole('button', { name: 'Confirm' })");
    assert.match(text, /confirm "Are you sure\?" was dismissed: to accept it, run `dialog accept`/);
    assert.equal(await status(), "confirm returned false");
  });

  it("answers as told, once", async () => {
    await open();
    await app.ok("dialog accept\nclick getByRole('button', { name: 'Confirm' })");
    assert.equal(await status(), "confirm returned true");
    await app.ok("click getByRole('button', { name: 'Confirm' })");
    assert.equal(await status(), "confirm returned false");
    await app.ok('dialog accept "Ada"\nclick getByRole(\'button\', { name: \'Prompt\' })');
    assert.equal(await status(), "prompt returned Ada");
    await app.ok("dialog dismiss\nclick getByRole('button', { name: 'Prompt' })");
    assert.equal(await status(), "prompt returned null");
    await app.ok("dialog accept\nclick getByRole('button', { name: 'Prompt' })");
    assert.equal(await status(), "prompt returned nobody");
  });

  it("answers a dialog a page opens as it loads, for the next page too", async () => {
    const text = await app.ok(`goto ${fixtures.base}/early-dialog`);
    assert.match(text, /confirm "On load\?" was dismissed/);
    assert.match(await app.ok("get title"), /answered false/);
    await app.ok(`dialog accept\ngoto ${fixtures.base}/early-dialog`);
    assert.match(await app.ok("get title"), /answered true/);
    await app.ok(`dialog accept\ngoto ${fixtures.base}/second`);
    await app.ok(`goto ${fixtures.base}/early-dialog`);
    assert.match(await app.ok("get title"), /answered true/, "An unused answer waits for the next dialog");
    await app.ok(`goto ${fixtures.base}/early-dialog`);
    assert.match(await app.ok("get title"), /answered false/, "It's used once");
  });
});

describe("new tabs from pages", () => {
  const countOf = async () => (await app.ok("tab list")).split("\n").filter((line) => /\(yours/.test(line)).length;

  it("opens a target=_blank link past the popup blocker, as the agent's tab", async () => {
    await open();
    const before = await countOf();
    const text = await app.ok("click getByRole('link', { name: 'New tab link' })");
    assert.match(text, /opened tab \d+/);
    await waitUntil(async () => (await countOf()) === before + 1, "the new tab");
    await waitUntil(async () => /from=blank/.test(await app.ok("tab list")), "the new tab's page");
    assert.match(await app.ok("get title"), /Kitchen sink/, "It stays on the current tab");
    const id = /(\d+) "[^"]*" — [^\n]*from=blank/.exec(await app.ok("tab list"))?.[1];
    await app.ok(`tab close ${id}`);
  });

  it("opens a link in a new tab with Control held, as a user would", async () => {
    await open();
    const text = await app.ok("click getByRole('link', { name: 'Second page' }) --modifiers Control");
    assert.match(text, /opened tab \d+/);
    assert.match(await app.ok("get title"), /Kitchen sink/);
    const list = await waitUntil(async () => {
      const value = await app.ok("tab list");
      return /from=link/.test(value) ? value : "";
    }, "the new tab's page");
    await app.ok(`tab close ${/(\d+) "[^"]*" — [^\n]*from=link/.exec(list)?.[1]}`);
  });

  it("respects a page that handles the click itself", async () => {
    await open();
    const text = await app.ok("click #prevented");
    assert.doesNotMatch(text, /opened tab/);
    assert.equal(await status(), "prevented");
  });

  it("opens window.open from an agent's click", async () => {
    await open();
    const text = await app.ok("click getByRole('button', { name: 'Open window' })");
    assert.match(text, /opened tab \d+/);
    const list = await waitUntil(async () => {
      const value = await app.ok("tab list");
      return /from=open/.test(value) ? value : "";
    }, "the new tab's page");
    const id = /(\d+) "[^"]*" — [^\n]*from=open/.exec(list)?.[1];
    await app.ok(`tab close ${id}`);
  });

  it("doesn't let a page open tabs on its own", async () => {
    await open();
    const before = await countOf();
    // Long after any agent action, so the popup blocker has the last word
    await app.ok('eval "() => { setTimeout(() => window.open(\'/second?from=unprompted\'), 2500); }"\nwait 3000');
    assert.equal(await countOf(), before);
  });
});

describe("hover, drag and scroll", () => {
  it("hovers", async () => {
    await open();
    await app.ok("hover #hoverable");
    assert.equal(await status(), "hovered");
  });

  it("drags and drops", async () => {
    await open();
    await app.ok("drag #source #dest");
    assert.equal(await status(), "dropped dragged");
  });

  it("scrolls and reports where it ended", async () => {
    await open();
    assert.match(await app.ok("scroll bottom"), /at the bottom of the page/);
    assert.match(await app.ok("scroll top"), /at the top of the page/);
    assert.match(await app.ok("scroll down 100"), /at 100 of \d+ px/);
    assert.match(await app.ok("scroll bottom --in #pane"), /at the bottom of the scroll area/);
    await app.ok("scroll #far");
    assert.match(await app.ok('eval "() => scrollY > 0"'), /true/);
    assert.match(await app.fails("scroll"), /Missing/);
  });
});

function jpegSize(data: Buffer) {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1]!;
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: data.readUInt16BE(i + 5), width: data.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

describe("screenshots", () => {
  it("captures the viewport of a tab in the background", async () => {
    await open();
    const result = await app.run("screenshot");
    assert.equal(result.isError, false, result.text);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0]!.mimeType, "image/jpeg");
    const data = Buffer.from(result.images[0]!.data, "base64");
    assert.equal(data[0], 0xff);
    assert.equal(data[1], 0xd8);
    assert.match(result.text, /\d+×\d+ JPEG/);
    const stats = await firefox.imageStats(result.images[0]!.data);
    assert.ok(stats.colors > 8, `A background tab's capture isn't blank: ${JSON.stringify(stats)}`);
  });

  it("captures what's actually there, in the page and in a cross-origin iframe", async () => {
    await open();
    // Known colors: #source is #ccc, and the box in the frame is #c33
    const source = await app.run("screenshot #source");
    const gray = await firefox.imageStats(source.images[0]!.data);
    assert.ok(Math.abs(gray.r - 204) < 25 && Math.abs(gray.g - 204) < 25 && Math.abs(gray.b - 204) < 25, JSON.stringify(gray));
    const framed = await app.run("screenshot frameLocator('#cross').locator('div')");
    assert.equal(framed.isError, false, framed.text);
    const red = await firefox.imageStats(framed.images[0]!.data);
    assert.ok(red.r > 170 && red.g < 90 && red.b < 90, `The frame's box is red: ${JSON.stringify(red)}`);
  });

  it("captures the scrolled part of the page", async () => {
    await open();
    const top = await firefox.imageStats((await app.run("screenshot")).images[0]!.data);
    await app.ok("scroll bottom");
    const bottom = await firefox.imageStats((await app.run("screenshot")).images[0]!.data);
    // The bottom of the page is a dark gradient, unlike the white top
    assert.ok(bottom.r < top.r - 10, `${JSON.stringify(top)} then ${JSON.stringify(bottom)}`);
  });

  it("captures the full page, within the size limit", async () => {
    const result = await app.run("screenshot --full");
    assert.equal(result.isError, false, result.text);
    const size = jpegSize(Buffer.from(result.images[0]!.data, "base64"))!;
    assert.ok(Math.max(size.width, size.height) <= 1568, `${size.width}×${size.height}`);
    assert.ok(size.height > size.width, "The page is tall");
  });

  it("captures an element, also inside an iframe", async () => {
    const result = await app.run("screenshot #go");
    assert.equal(result.isError, false, result.text);
    const size = jpegSize(Buffer.from(result.images[0]!.data, "base64"))!;
    assert.ok(size.width < 200 && size.height < 100, `${size.width}×${size.height}`);
    const framed = await app.run("screenshot frameLocator('#cross').getByRole('button')");
    assert.equal(framed.isError, false, framed.text);
    assert.equal(framed.images.length, 1);
  });

  it("captures after scrolling, and saves with --path", async () => {
    await app.ok("scroll bottom");
    const file = path.join(files, "shots", "page.jpg");
    const result = await app.run(`screenshot --path "${file}"`);
    assert.equal(result.isError, false, result.text);
    assert.match(result.text, /saved to/);
    assert.equal(readFileSync(file)[0], 0xff);
  });

  it("includes at most three images per call", async () => {
    const result = await app.run("screenshot\nscreenshot\nscreenshot\nscreenshot");
    assert.equal(result.images.length, 3);
    assert.match(result.text, /left out/);
  });
});

describe("batches", () => {
  it("runs steps in order and stops at the first error", async () => {
    await open();
    const text = await app.fails('fill #name "x"\nclick #missing\nclick #go\nclick #go');
    assert.match(text, /✓ fill #name/);
    assert.match(text, /✗ step 2: click #missing — Nothing matches/);
    assert.match(text, /Steps 3–4 not run/);
    assert.match(text, /Page: .* — "Kitchen sink"/);
    assert.equal(await status(), "idle");
  });

  it("runs nothing when any line doesn't parse", async () => {
    await open();
    const text = await app.fails('click #go\nfill "unterminated');
    assert.match(text, /Nothing ran/);
    assert.equal(await status(), "idle");
    assert.match(await app.fails("frobnicate"), /Unknown command frobnicate/);
    assert.match(await app.fails("click #go --nope"), /no --nope flag/);
    assert.match(await app.fails("click #go #extra"), /at most 1 argument/);
  });

  it("ignores comments and blank lines", async () => {
    assert.match(await app.ok("\n# a comment\n\nget title\n"), /Kitchen sink/);
  });
});

describe("the user's controls", () => {
  it("Stop refuses agents until Resume", async () => {
    await open();
    await firefox.clickInPopup("stop");
    try {
      await waitUntil(async () => /Stop/.test((await app.run("get title")).text), "Stop to take effect");
      assert.match(await app.fails("click #go"), /pressed Stop/);
      await waitUntil(async () => /Stopped/.test(await firefox.popupText("status")), "the popup to say so");
    } finally {
      await firefox.popup(`await browser.runtime.sendMessage({ type: "resume" });`);
    }
    await waitUntil(async () => !(await app.run("get title")).isError, "Resume to take effect");
    await app.ok("click #go");
  });

  it("shows the tabs in use", async () => {
    // By the page's own title, which a tab that was never shown is slow to report
    await waitUntil(async () => /Kitchen sink/.test(await firefox.popupText("tabs")), "the popup to list the tab", 3000);
    assert.match(await firefox.popupText("tabs"), /Test App/);
  });
});

describe("the user's own tabs", () => {
  it("can be selected, and only then are touched", async () => {
    // A tab the agent didn't open, as if the user had: opened from another app's session and left behind
    const other = await McpApp.start(home.dir, home.port, "Other App");
    try {
      const created = await other.ok(`tab new ${fixtures.base}/second?user=1`);
      const id = /tab (\d+)/.exec(created)?.[1];
      const list = await app.ok("tab list");
      const line = list.split("\n").find((item) => item.includes(`${id} "`));
      assert.ok(line, list);
      assert.doesNotMatch(line, /yours/);
      await app.ok(`tab select ${id}`);
      assert.match(await app.ok("get url"), /user=1/);
      assert.match(await app.ok("tab list"), new RegExp(`\\* ${id} .*\\(yours`));
      assert.match(await app.fails(`tab close ${id}`), /isn't one you opened/);
      await other.ok(`tab close ${id}`);
    } finally {
      await other.close();
    }
    await open();
  });
});

describe("several AI apps", () => {
  it("share one daemon and the browser, each with its own tab", async () => {
    const first = await McpApp.start(home.dir, home.port, "App One");
    const second = await McpApp.start(home.dir, home.port, "App Two");
    const pid = home.info()?.pid;
    try {
      await Promise.all([first.ok(`goto ${fixtures.base}/second?app=1`), second.ok(`goto ${fixtures.base}/second?app=2`)]);
      assert.match(await first.ok("get url"), /app=1/);
      assert.match(await second.ok("get url"), /app=2/);
      assert.equal(home.info()?.pid, pid);
      await first.ok("tab close");
      await second.ok("tab close");
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("starting at once still gives one daemon", async () => {
    await home.stopDaemon();
    const apps = await Promise.all([1, 2, 3].map((n) => McpApp.start(home.dir, home.port, `Racer ${n}`)));
    try {
      const results = await Promise.all(apps.map((racer) => racer.tools()));
      for (const tools of results) assert.equal(tools[0]?.name, "browser");
      const { pid } = home.info()!;
      assert.ok(pid);
      await waitUntil(async () => !(await apps[0]!.run("tab list")).isError, "the browser to reconnect", 20_000);
      assert.equal(home.info()?.pid, pid);
    } finally {
      await Promise.all(apps.map((racer) => racer.close()));
    }
  });
});

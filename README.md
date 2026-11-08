<img src="docs/logo.png" alt="" width="96">

# MCP for Firefox

Lets AI apps (Claude Code, Cursor, VS Code, Claude Desktop…) use **your own Firefox**: your signed-in sites and your profile, in tabs of their own. Everything runs on your computer.

It's [Browser MCP](https://github.com/browsermcp/mcp) for Firefox, with the same `browser` tool and command language, so prompts written for it carry over. The way it drives the browser had to be rebuilt, because Browser MCP relies on `chrome.debugger`, which Firefox doesn't have ([what that changes](#what-firefox-does-differently)).

```
AI app ──stdio──▶ firefox-mcp ──▶ daemon (one per user, on 127.0.0.1) ──▶ extension ──▶ your tabs
```

## Install

You need Node.js 20 or later and Firefox 140 or later.

**1. Build it**

```sh
npm install
npm run build
```

**2. Load the extension.** It isn't listed on addons.mozilla.org, so pick one:

| | How | Lasts |
| --- | --- | --- |
| **Any Firefox** | In Firefox, click the `.xpi` in the [latest release](https://github.com/dh1011/firefox-mcp/releases/latest), signed by Mozilla, and allow the install | Permanently |
| **Try your own build** | `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `dist/extension/manifest.json` | Until Firefox restarts |
| **Your own build, in Nightly or Developer Edition** | Set `xpinstall.signatures.required` to `false` in `about:config`, run `npm run package:extension`, then open the `.xpi` from `dist/artifacts` in `about:addons` → gear → **Install Add-on From File…** | Permanently |
| **Your own build, in regular Firefox** | Change the add-on ID in `src/extension/static/manifest.json` to one of your own, then get it signed by Mozilla as an unlisted add-on: `npx web-ext sign --channel unlisted --source-dir dist/extension --api-key … --api-secret …` ([API keys](https://addons.mozilla.org/developers/addon/api/key/)), and install the `.xpi` | Permanently |

**3. Add the server to your AI app's MCP config**

```json
{
  "mcpServers": {
    "firefox": {
      "command": "node",
      "args": ["/path/to/firefox-mcp/dist/server/index.js"]
    }
  }
}
```

For Claude Code: `claude mcp add firefox -- node /path/to/firefox-mcp/dist/server/index.js`

**4. Approve it.** Ask the AI app to do something in the browser. The first time, the toolbar button shows **!**. Open it, check that the six-digit code matches the one the AI app shows, and click **Allow**. That's once per computer.

## What agents can do

One tool, `browser`, takes command lines and runs them in order, stopping at the first error:

```
goto https://example.com/login
fill getByLabel('Email') "ada@example.com"
fill getByLabel('Password') "…" --submit
wait --text "Welcome"
snapshot -i
```

| | |
| --- | --- |
| Navigate | `goto`, `back`, `forward`, `reload` |
| Act | `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `upload`, `hover`, `drag`, `scroll`, `dialog` |
| Look | `snapshot [-i]`, `find "<text>"`, `get text\|value\|count\|attr\|url\|title`, `screenshot [--full]`, `eval` |
| Debug | `console`, `requests`, `request <id> --body` |
| Tabs | `tab list\|new\|select\|close\|show` |
| Wait | `wait <ms>`, `wait --text`, `wait --gone`, `wait --url`, `wait <target>` |

Targets are refs from a snapshot (`e12`, or `f1e3` in an iframe), locators (`getByRole('button', { name: 'Go' })`, `getByLabel`, `getByText`, `getByPlaceholder`, `getByTestId`, `.first()`, `.nth(i)`, `.filter({ hasText })`, `frameLocator('#f').getByText('…')`) or CSS. They reach into shadow roots, closed ones too, and cross-origin iframes. `fill` and `upload` are the exception: they look only in the page itself unless the target is a ref or goes through `frameLocator`, so a password meant for the page can't land in an ad's or a widget's iframe. `help <command>` prints the details.

## What Firefox does differently

Firefox's extension API has no way to send real input, attach a debugger or answer a dialog, so these work differently from Browser MCP:

| | What happens here | What that means |
| --- | --- | --- |
| **Clicks and keys** | Synthesized, so `isTrusted` is `false` for mouse and key events | **A site that checks `isTrusted` ignores them.** Most don't. Anything needing a real user gesture stays blocked: fullscreen, clipboard, payment sheets |
| **Typing** | `execCommand("insertText")`, whose `input` events *are* trusted | Works with React and rich editors |
| **Key effects** | Done by the extension: Enter submits, Tab moves focus, arrows move the caret, and so on | Browser shortcuts don't work |
| **Hover** | Mouse events only | Menus that listen for them open; CSS `:hover` doesn't apply |
| **Dialogs** | `alert`, `confirm` and `prompt` are answered instantly: set the answer with `dialog accept` *before* the step that opens one. Otherwise `confirm` and `prompt` are dismissed, and the step says so | A page can't be left waiting on a dialog |
| **Popups** | A link or `window.open` from an agent's click opens as a new tab, past the popup blocker | The page gets no `window` object, so login flows that talk to their popup through `window.opener` don't work |
| **Background tabs** | Agents work in the background, where Firefox slows timers to about 1 s and stops animation frames | A page that seems stuck may need `tab show`, which takes your focus |
| **`eval` under a strict CSP** | Runs in the extension's isolated world, and says so | It sees the DOM; the page's own variables are under `window.wrappedJSObject`. Its `fetch` can read other sites with your cookies, which the page's can't ([Security](#security)) |
| **File pickers** | Files are set directly on the input, and pickers a click opens are intercepted | |
| **Accessibility tree** | Computed from the DOM, as extensions can't read Firefox's own | Close to the real one, but names ignore CSS `content` |

Firefox makes up for some of that with APIs of its own: `tabs.captureTab` takes screenshots of background tabs without bringing them forward, `filterResponseData` lets `request --body` read responses as they pass, and hooks installed with `exportFunction` run without touching the page's world, so a page's CSP doesn't affect them and it can't forge what they report.

The extension uses Manifest V2 on purpose: only a persistent background page keeps the connection to the server open, and Firefox continues to support it.

**Not supported yet:** several Firefox profiles at once (a second one is told another is connected; Browser MCP supports this).

## Security

This gives AI apps the use of your signed-in browser, so it's worth knowing what stands in the way:

- **You approve each server**, by matching a code. The extension then checks a signature on every connection, so a program that takes over the port can't drive your browser.
- **The extension enforces the rules**, whatever the server asks: no browser pages, extension pages, local files or Mozilla's add-on and account sites, and nothing while you've pressed **Stop**. Private windows are only reachable if you turn on *Run in Private Windows* for the extension.
- **Web pages can't reach the daemon.** It only listens on `127.0.0.1`, checks `Host` against DNS rebinding, takes only `moz-extension://` origins on the extension's socket, and requires a token for everything else.
- **Your other tabs are left alone** unless an agent selects one. Nothing is injected and no requests are watched until a tab is claimed. Tabs in use are in a tab group named after the AI app.
- **Passwords and credentials are kept out of transcripts where their names give them away**: password fields are masked in snapshots, typed text isn't echoed, and request details hide headers, URL parameters, form fields and JSON keys named like credentials (cookies, tokens, keys, passwords, sessions). A credential under some other name, or in a response body, still shows. `get value` and `eval` can still read what a page can.

**What it doesn't protect against yet:**

- **Files on your computer.** `upload` sends the page any file you can read, and `screenshot --path` writes wherever it's told, replacing what's there. An agent talked into it by a page could use either, so check the paths in those steps before you approve them.
- **`eval` in the isolated world.** Under a strict CSP, `eval` runs with the extension's reach: its `fetch` and `XMLHttpRequest` can read other sites with your cookies. A page can make that happen without a CSP, and in the page's own world it can replace `eval`, see the agent's code and forge the answer.
- **Other accounts on the same computer.** Every account can reach `127.0.0.1`. Another account's program can pose as the extension to the daemon, seeing what agents type and feeding them made-up pages, or take the daemon's port before it starts and pose as the daemon to AI apps, getting its token and reading and writing your files through them. Use it on a computer you don't share.

**The risk that remains is prompt injection.** Pages are untrusted, and a malicious one can try to talk the AI into misusing your logged-in sessions. The server tells agents not to follow instructions from pages, but that isn't a guarantee. Watch what agents do on sites that matter, and press **Stop** if something looks wrong.

**Reviewers should know:** `eval` runs code supplied by the local server, which is why this may not pass review for a *listed* addons.mozilla.org add-on. Unlisted signing (above) is the expected route.

## Development

```sh
npm run build            # dist/server, dist/extension
npm run typecheck
npm test                 # unit tests
npm run test:e2e         # real Firefox, through the real MCP server
npm run lint:extension   # web-ext lint
```

The end-to-end tests run Firefox headless with a temporary profile, a temporary server home and random ports, so they never touch your own Firefox or daemon. They find Firefox in the usual places; set `FIREFOX_BINARY` to pick one and `FIREFOX_HEADED=1` to watch.

| Folder | |
| --- | --- |
| `src/protocol.ts` | The extension ↔ daemon protocol, and pairing |
| `src/server/` | The stdio process (`thin.ts`), the daemon, and the command language (`commands.ts`, `engine.ts`, `parser.ts`, `targets.ts`) |
| `src/extension/background/` | The connection, the tab rules (`rules.ts`), tabs and navigation (`tabs.ts`, `page.ts`) |
| `src/extension/content/` | What runs in pages: the snapshot and accessibility tree, locators, input, and the hooks |

The server keeps its key, token and log in `~/.firefox-mcp` (`FIREFOX_MCP_HOME` to change it). The daemon exits ten minutes after the last AI app leaves.

## License

[Apache-2.0](LICENSE). The command language and pairing design come from [Browser MCP](https://github.com/browsermcp/mcp); see [NOTICE](NOTICE). This project isn't affiliated with or endorsed by Browser MCP or Mozilla.

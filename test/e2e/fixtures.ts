/** The pages the end-to-end tests drive, served from loopback. `other` is another origin, for cross-origin iframes */
import { createServer, type Server } from "node:http";

const LAYOUT = `<style>body{font:16px sans-serif;margin:8px}#overlay{position:fixed;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.2);display:none}</style>`;

const KITCHEN_SINK = `<!doctype html><html><head><title>Kitchen sink</title>${LAYOUT}<script>
window.events = [];
window.log = (entry) => { window.events.push(entry); document.getElementById('status').textContent = entry; };
console.log('early log from head');
</script></head><body>
<header><nav aria-label="Main"><a href="/second?from=link">Second page</a></nav></header>
<main>
<h1>Kitchen sink</h1>
<p id="status">idle</p>
<p>Some <b>bold</b> text in a paragraph.</p>
<button id="go" onclick="log('clicked trusted=' + event.isTrusted)">Go</button>
<button id="dbl" ondblclick="log('double')">Double me</button>
<button id="ctx" oncontextmenu="log('context'); event.preventDefault()">Context me</button>
<button disabled>Disabled one</button>
<button style="display:none">Hidden one</button>
<button class="dup">Same</button><button class="dup">Same</button>
<div id="pointer" style="cursor:pointer" onclick="log('div clicked')">A clickable div</div>

<form id="form" onsubmit="event.preventDefault(); log('submitted ' + new FormData(this).get('name'))">
  <label>Name <input name="name" id="name" oninput="window.events.push('name input trusted=' + event.isTrusted)"></label>
  <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com">
  <label>Password <input id="password" type="password"></label>
  <label>Age <input id="age" type="number"></label>
  <label>When <input id="when" type="date"></label>
  <label>Volume <input id="volume" type="range" min="0" max="10"></label>
  <label>Notes <textarea id="notes"></textarea></label>
  <label><input id="agree" type="checkbox" onchange="log('agree ' + this.checked)"> I agree</label>
  <label class="custom"><input id="fancy" type="checkbox" style="opacity:0;position:absolute;width:0;height:0"><span>Fancy box</span></label>
  <label><input type="radio" name="size" value="s"> Small</label>
  <label><input type="radio" name="size" value="l"> Large</label>
  <label>Country <select id="country" onchange="log('country ' + this.value)"><option value="">Pick</option><option value="ca">Canada</option><option value="jp">Japan</option></select></label>
  <label>Many <select id="many" multiple><option value="a">Alpha</option><option value="b">Beta</option><option value="c">Gamma</option></select></label>
  <button type="submit">Send</button>
</form>
<input id="tracked" aria-label="Tracked">
<div id="editor" contenteditable="true" aria-label="Editor" onbeforeinput="window.events.push('editor beforeinput trusted=' + event.isTrusted)"></div>
<input id="upload" type="file" multiple onchange="log('files ' + Array.from(this.files).map(f => f.name + ':' + f.size).join(','))">
<button id="pick" onclick="const i = document.createElement('input'); i.type='file'; i.onchange=()=>log('picked ' + i.files[0].name); i.click();">Choose a file</button>

<button onclick="log('alert returned ' + alert('Hello alert'))">Alert</button>
<button onclick="log('confirm returned ' + confirm('Are you sure?'))">Confirm</button>
<button onclick="log('prompt returned ' + prompt('Your name?', 'nobody'))">Prompt</button>

<button onclick="console.log('a log', {a: 1}); console.warn('a warning'); console.error('an error')">Log things</button>
<button onclick="setTimeout(() => { throw new Error('thrown in timer'); }, 0)">Throw</button>
<button onclick="fetch('/api/data', {method: 'POST', headers: {'content-type': 'application/json', 'authorization': 'Bearer SECRET'}, body: '{&quot;q&quot;:1}'}).then(r => r.json()).then(d => log('fetched ' + d.value))">Fetch</button>
<button onclick="setTimeout(() => { document.getElementById('late').textContent = 'Arrived late'; document.getElementById('late').hidden = false; }, 400)">Later</button>
<p id="late" hidden></p>
<a href="/second?from=blank" target="_blank">New tab link</a>
<button onclick="window.open('/second?from=open'); log('open called')">Open window</button>
<a id="prevented" href="/second?from=prevented" target="_blank" onclick="event.preventDefault(); log('prevented')">Prevented link</a>

<div id="hoverable" onmouseenter="log('hovered')">Hover me</div>
<div id="source" draggable="true" ondragstart="event.dataTransfer.setData('text/plain','dragged')" style="width:60px;height:30px;background:#ccc">Drag</div>
<div id="dest" ondragover="event.preventDefault()" ondrop="event.preventDefault(); log('dropped ' + event.dataTransfer.getData('text/plain'))" style="width:120px;height:60px;background:#eee">Drop here</div>

<dialog id="modal"><p>In a modal</p><button>Modal button</button></dialog>
<button onclick="document.getElementById('modal').showModal()">Open modal</button>
<details><summary>More</summary><p>Details body</p></details>
<table><caption>Scores</caption><thead><tr><th>Who</th><th>Score</th></tr></thead><tbody><tr><th>Ann</th><td>9</td></tr></tbody></table>
<ul><li>One</li><li><a href="#two">Two</a></li></ul>
<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="A tiny image" width="20" height="20">

<div id="open-host"></div><div id="closed-host"></div>
<iframe id="same" title="Same origin" src="/frame" width="300" height="120"></iframe>
<iframe id="cross" title="Cross origin" src="__OTHER__/frame" width="300" height="120"></iframe>

<div id="pane" style="height:60px;overflow:auto"><div style="height:400px">Tall content</div></div>
<button onclick="document.getElementById('overlay').style.display='block'">Show overlay</button>
<button id="behind" onclick="log('behind clicked')">Behind</button>
<div id="overlay" onclick="this.style.display='none'; log('overlay clicked')"></div>
<div style="height:1500px;background:linear-gradient(#fafafa,#88a)">Tall</div>
<button id="far" onclick="log('far clicked')">Far below</button>
</main>
<script>
document.getElementById('open-host').attachShadow({mode:'open'}).innerHTML = '<button onclick="log(\\'open shadow clicked\\')">Open shadow button</button>';
document.getElementById('closed-host').attachShadow({mode:'closed'}).innerHTML = '<button onclick="log(\\'closed shadow clicked\\')">Closed shadow button</button>';
// As React does: a value tracker on the instance. A change that goes around it is what triggers onChange
const tracked = document.getElementById('tracked');
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
let last = '';
Object.defineProperty(tracked, 'value', { configurable: true, get() { return native.get.call(this); }, set(v) { last = String(v); native.set.call(this, v); } });
tracked.addEventListener('input', () => { if (tracked.value !== last) { last = tracked.value; log('tracked change ' + tracked.value); } });
</script>
</body></html>`;

const FRAME = (label: string) => `<!doctype html><title>${label}</title><p>Frame says ${label}</p><button onclick="this.textContent = 'Clicked in ${label}'">Frame button ${label}</button><input aria-label="Frame field ${label}"><div style="width:40px;height:20px;background:#c33"></div>`;

/** A third-party iframe has a field labelled like the page's own, which arrives a moment later, as in a single-page app */
const LATE_FIELD = `<!doctype html><title>Late field</title><iframe id="cross" src="__OTHER__/frame"></iframe><div id="app"></div><script>setTimeout(() => { document.getElementById('app').innerHTML = '<input id="own" aria-label="Frame field other">'; }, 1500);</script>`;

const SECOND = `<!doctype html><title>Second</title><h1>Second page</h1><p id="query"></p><script>document.getElementById('query').textContent = location.search; console.log('second page loaded');</script><a href="/">Back home</a>`;

const CSP = `<!doctype html><title>Strict</title><h1>Strict page</h1><script src="/csp.js"></script>`;

const EARLY_DIALOG = `<!doctype html><title>Early dialog</title><script>window.answer = confirm('On load?'); document.title = 'answered ' + window.answer;</script><p>Loaded</p>`;

export type Fixtures = {
  base: string;
  other: string;
  close(): Promise<void>;
};

function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

export async function startFixtures(): Promise<Fixtures> {
  const other = await serve((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(FRAME("other"));
  });
  const main = await serve((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const html = (body: string) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(body);
    };
    switch (pathname) {
      case "/":
        return html(KITCHEN_SINK.replaceAll("__OTHER__", other.url));
      case "/second":
        return html(SECOND);
      case "/late-field":
        return html(LATE_FIELD.replaceAll("__OTHER__", other.url));
      case "/frame":
        return html(FRAME("same"));
      case "/csp":
        response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'");
        return html(CSP);
      case "/csp.js":
        response.setHeader("content-type", "text/javascript");
        return response.end("window.fromPage = 'page variable';");
      case "/early-dialog":
        return html(EARLY_DIALOG);
      case "/api/data":
        response.setHeader("content-type", "application/json");
        response.setHeader("set-cookie", "session=SECRET; HttpOnly");
        return response.end(JSON.stringify({ value: 42 }));
      case "/empty":
        response.statusCode = 204;
        return response.end();
      case "/redirect":
        response.statusCode = 302;
        response.setHeader("location", "/second?from=redirect");
        return response.end();
      case "/slow":
        setTimeout(() => html("<!doctype html><title>Slow</title><p>Slow page</p>"), 1000);
        return;
      default:
        response.statusCode = 404;
        return html("<!doctype html><title>Not found</title><p>Not found</p>");
    }
  });
  return {
    base: main.url,
    other: other.url,
    close: async () => {
      main.server.closeAllConnections();
      other.server.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => main.server.close(resolve)),
        new Promise((resolve) => other.server.close(resolve)),
      ]);
    },
  };
}

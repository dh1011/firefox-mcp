/**
 * Runs the real thing: Firefox with the built extension, and the MCP server over stdio as an AI app runs it. Everything
 * is temporary: the profile, the server's home and the ports, so a run never touches a real profile or daemon.
 *
 * Firefox is found in the usual places, or set FIREFOX_BINARY. Set FIREFOX_HEADED=1 to watch it.
 */
import { execFileSync, type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import WebSocket from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXTENSION_ID = "mcp-for-firefox@firefox-mcp.local";
/** A fixed internal UUID, through a pref, so the tests can open the popup's page */
const EXTENSION_UUID = "0f1e2d3c-4b5a-4678-9abc-def012345678";

function firefoxBinary(): string {
  const candidates = [
    process.env.FIREFOX_BINARY,
    "C:/Program Files/Mozilla Firefox/firefox.exe",
    "C:/Program Files/Firefox Developer Edition/firefox.exe",
    "C:/Program Files/Firefox Nightly/firefox.exe",
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    "/usr/bin/firefox",
    "/usr/bin/firefox-nightly",
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("Firefox wasn't found. Set FIREFOX_BINARY");
  return found;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil<T>(check: () => T | Promise<T>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    }
    await sleep(100);
  }
}

/** Firefox, driven over WebDriver BiDi only for what a user does by hand: opening the extension's popup */
export class Firefox {
  private nextId = 1;
  private readonly pending = new Map<number, (value: { result?: unknown; error?: string; message?: string }) => void>();
  private popupContext: string | null = null;

  private constructor(
    private readonly process: ChildProcess,
    private readonly profile: string,
    private readonly socket: WebSocket,
  ) {
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: string; message?: string };
      if (message.id !== undefined) {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      }
    });
  }

  static async launch(): Promise<Firefox> {
    const profile = mkdtempSync(path.join(tmpdir(), "firefox-mcp-e2e-"));
    const prefs: Record<string, unknown> = {
      // What a real profile has, which automation otherwise turns off
      "dom.disable_open_during_load": true,
      "extensions.webextensions.uuids": JSON.stringify({ [EXTENSION_ID]: EXTENSION_UUID }),
      "browser.shell.checkDefaultBrowser": false,
      "datareporting.policy.dataSubmissionEnabled": false,
      "browser.aboutwelcome.enabled": false,
      "app.update.enabled": false,
    };
    writeFileSync(
      path.join(profile, "user.js"),
      Object.entries(prefs)
        .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
        .join("\n"),
    );
    // System access: only a privileged page may open the extension's popup, which web pages can't reach
    const args = ["--no-remote", "--profile", profile, "--remote-debugging-port", "0"];
    if (!process.env.FIREFOX_HEADED) args.unshift("--headless");
    const child = spawn(firefoxBinary(), args, {
      stdio: "ignore",
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    });
    const info = path.join(profile, "WebDriverBiDiServer.json");
    const server = await waitUntil(
      () => JSON.parse(readFileSync(info, "utf8")) as { ws_host: string; ws_port: number },
      "Firefox to start",
      30_000,
    );
    const socket = new WebSocket(`ws://${server.ws_host}:${server.ws_port}/session`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const firefox = new Firefox(child, profile, socket);
    await firefox.command("session.new", { capabilities: { alwaysMatch: { unhandledPromptBehavior: "ignore" } } });
    await firefox.command("webExtension.install", {
      extensionData: { type: "path", path: path.join(ROOT, "dist/extension") },
    });
    return firefox;
  }

  private command(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error}: ${message.message}`));
        else resolve(message.result);
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs code in the extension's popup page, as if the user had it open */
  async popup<T = unknown>(code: string): Promise<T> {
    this.popupContext ??= await this.openPopupTab();
    const reply = (await this.command("script.evaluate", {
      expression: `(async () => { ${code} })()`,
      target: { context: this.popupContext },
      awaitPromise: true,
      resultOwnership: "none",
    })) as { type: string; result?: { value?: unknown }; exceptionDetails?: { text: string } };
    if (reply.type === "exception") throw new Error(reply.exceptionDetails?.text);
    return reply.result?.value as T;
  }

  private async openPopupTab(): Promise<string> {
    const url = `moz-extension://${EXTENSION_UUID}/popup.html`;
    const chrome = (await this.command("browsingContext.getTree", { "moz:scope": "chrome" })) as {
      contexts: { context: string; url: string }[];
    };
    const window = chrome.contexts.find((item) => item.url.includes("browser.xhtml"));
    if (!window) throw new Error("No browser window");
    await this.command("script.evaluate", {
      expression: `gBrowser.addTab(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(), inBackground: true }); 1`,
      target: { context: window.context },
      awaitPromise: false,
    });
    return waitUntil(async () => {
      const tree = (await this.command("browsingContext.getTree", {})) as {
        contexts: { context: string; url: string }[];
      };
      const tab = tree.contexts.find((item) => item.url === url);
      if (!tab) return "";
      // The popup's script has run once its status line has something to say
      const reply = (await this.command("script.evaluate", {
        expression: "document.getElementById('status')?.textContent ?? ''",
        target: { context: tab.context },
        awaitPromise: false,
      })) as { result?: { value?: string } };
      return reply.result?.value ? tab.context : "";
    }, "the popup to open");
  }

  async setPort(port: number) {
    await this.popup(`await browser.runtime.sendMessage({ type: "setPort", port: ${port} });`);
  }

  /** Decodes an image in the browser: its size, how many colors it has, and its average color */
  async imageStats(base64: string, mimeType = "image/jpeg") {
    const json = await this.popup<string>(`
      const image = new Image();
      image.src = "data:${mimeType};base64,${base64}";
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const colors = new Set();
      let r = 0, g = 0, b = 0;
      for (let i = 0; i < data.length; i += 4) {
        colors.add((data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | data[i + 2] >> 3);
        r += data[i]; g += data[i + 1]; b += data[i + 2];
      }
      const n = data.length / 4;
      return JSON.stringify({ width: image.width, height: image.height, colors: colors.size, r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) });
    `);
    return JSON.parse(json) as { width: number; height: number; colors: number; r: number; g: number; b: number };
  }

  popupText(id: string) {
    return this.popup<string>(`return document.getElementById(${JSON.stringify(id)}).textContent;`);
  }

  clickInPopup(id: string) {
    return this.popup(`document.getElementById(${JSON.stringify(id)}).click();`);
  }

  async close() {
    this.socket.terminate();
    const pid = this.process.pid;
    if (pid !== undefined) {
      if (process.platform === "win32") {
        // The whole tree: Firefox's content processes hold the profile otherwise
        try {
          execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
        } catch {
          // Gone already
        }
      } else {
        this.process.kill("SIGKILL");
      }
    }
    await removeWithRetry(this.profile);
  }
}

async function removeWithRetry(dir: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(300);
    }
  }
}

export type McpResult = { text: string; isError: boolean; images: { data: string; mimeType: string }[] };

/** An AI app: the MCP SDK's client, running the built server over stdio */
export class McpApp {
  private constructor(private readonly client: Client) {}

  static async start(home: string, port: number, name = "Test App"): Promise<McpApp> {
    const client = new Client({ name, version: "1.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(ROOT, "dist/server/index.js"), "--port", String(port)],
        env: { ...(process.env as Record<string, string>), FIREFOX_MCP_HOME: home },
        stderr: "inherit",
      }),
    );
    return new McpApp(client);
  }

  instructions() {
    return this.client.getInstructions();
  }

  async tools() {
    return (await this.client.listTools()).tools;
  }

  /** Runs command lines through the `browser` tool */
  async run(commands: string): Promise<McpResult> {
    const result = (await this.client.callTool(
      { name: "browser", arguments: { commands } },
      undefined,
      { timeout: 120_000 },
    )) as CallToolResult;
    const text = result.content
      .filter((item) => item.type === "text")
      .map((item) => (item as { text: string }).text)
      .join("\n");
    const images = result.content
      .filter((item) => item.type === "image")
      .map((item) => item as unknown as { data: string; mimeType: string });
    return { text, isError: !!result.isError, images };
  }

  /** Runs command lines that must succeed */
  async ok(commands: string): Promise<string> {
    const result = await this.run(commands);
    if (result.isError) throw new Error(`Expected success:\n${commands}\n---\n${result.text}`);
    return result.text;
  }

  /** Runs command lines that must fail */
  async fails(commands: string): Promise<string> {
    const result = await this.run(commands);
    if (!result.isError) throw new Error(`Expected failure:\n${commands}\n---\n${result.text}`);
    return result.text;
  }

  async close() {
    await this.client.close();
  }
}

/** The server's temporary home, and a way to stop whatever daemon it runs */
export class ServerHome {
  readonly dir = mkdtempSync(path.join(tmpdir(), "firefox-mcp-home-"));

  constructor(readonly port: number) {}

  info(): { port: number; pid: number; token: string } | null {
    try {
      return JSON.parse(readFileSync(path.join(this.dir, `daemon-${this.port}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  async stopDaemon() {
    const info = this.info();
    if (!info) return;
    try {
      await fetch(`http://127.0.0.1:${info.port}/shutdown?token=${encodeURIComponent(info.token)}`, { method: "POST" });
    } catch {
      // Gone already
    }
    await waitUntil(async () => {
      try {
        await fetch(`http://127.0.0.1:${info.port}/firefox-mcp/status`);
        return false;
      } catch {
        return true;
      }
    }, "the daemon to stop");
  }

  async remove() {
    await this.stopDaemon();
    await removeWithRetry(this.dir);
  }
}

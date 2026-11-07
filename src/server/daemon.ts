/**
 * The daemon: one per user, on loopback. It holds the browser's connection and the engine, and serves the thin process
 * of each AI app. What it checks, since any web page can try to reach a port on 127.0.0.1:
 *
 * - The `Host` header must be loopback, which stops DNS rebinding.
 * - `/extension` takes only `moz-extension://` origins, which pages can't forge. The extension then makes the daemon
 *   prove its key and the user approve it.
 * - `/client` and `/shutdown` need the token from `daemon.json`, which only this user can read, and refuse any `Origin`.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

import { PRODUCT, RELAY_PORTS, RELAY_PROTOCOL_VERSION, RelayPaths, type RelayStatus } from "../protocol";
import { CLIENT_PROTOCOL_VERSION, type ClientHello, type ClientToDaemonMethods, type DaemonInfo, type DaemonToClientMethods, type DaemonWelcome } from "./contracts";
import { Engine } from "./engine";
import { ExtensionConnection } from "./extension-connection";
import { daemonInfoPath, ensureHome, loadIdentity, RELAY_HOST, randomToken, writePrivateFile } from "./paths";
import { RpcPeer } from "./rpc";

export type DaemonOptions = {
  home: string;
  version: string;
  /** This port only; otherwise the first free one of `RELAY_PORTS` */
  port?: number;
  /** Exits this long after the last AI app left */
  idleExitMs?: number;
  log?: (...args: unknown[]) => void;
  onExit?: () => void;
};

const DEFAULT_IDLE_EXIT_MS = 10 * 60_000;
/** Screenshots and uploads travel as base64 */
const MAX_PAYLOAD = 100 * 1024 * 1024;

export class Daemon {
  private server: Server | null = null;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private readonly token = randomToken();
  private readonly clients = new Set<WebSocket>();
  private readonly log: (...args: unknown[]) => void;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private boundPort = 0;
  readonly extension: ExtensionConnection;
  readonly engine: Engine;

  constructor(private readonly options: DaemonOptions) {
    this.log = options.log ?? (() => {});
    ensureHome(options.home);
    const identity = loadIdentity(options.home);
    this.extension = new ExtensionConnection(identity, () => this.boundPort, options.version, this.log, () => this.engine.forgetClaims());
    this.engine = new Engine(this.extension, { log: this.log });
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    const ports = this.options.port ? [this.options.port] : RELAY_PORTS;
    let lastError: unknown;
    for (const port of ports) {
      try {
        this.server = await this.listen(port);
        this.boundPort = port;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.server) throw new Error(`Couldn't listen on ${ports.join(", ")}: ${String(lastError)}`);
    const info: DaemonInfo = { port: this.boundPort, pid: process.pid, version: this.options.version, token: this.token };
    writePrivateFile(daemonInfoPath(this.options.home, this.options.port), JSON.stringify(info));
    this.scheduleIdleExit();
    this.log(`listening on ${RELAY_HOST}:${this.boundPort}`);
  }

  private listen(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.onHttp(request, response));
      server.on("upgrade", (request, socket, head) => this.onUpgrade(request, socket, head));
      server.once("error", reject);
      server.listen(port, RELAY_HOST, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
    this.options.onExit?.();
  }

  private isLoopbackHost(request: IncomingMessage): boolean {
    const host = request.headers.host ?? "";
    return host === `127.0.0.1:${this.boundPort}` || host === `localhost:${this.boundPort}`;
  }

  private hasToken(request: IncomingMessage): boolean {
    const url = new URL(request.url ?? "/", "http://localhost");
    return url.searchParams.get("token") === this.token;
  }

  private onHttp(request: IncomingMessage, response: ServerResponse) {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    if (!this.isLoopbackHost(request)) {
      response.writeHead(403).end();
      return;
    }
    if (request.method === "GET" && pathname === RelayPaths.status) {
      const status: RelayStatus = { product: PRODUCT, protocol: RELAY_PROTOCOL_VERSION, version: this.options.version, pid: process.pid };
      // No CORS headers: pages can't read this
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(status));
      return;
    }
    if (request.method === "POST" && pathname === RelayPaths.shutdown) {
      if (request.headers.origin || !this.hasToken(request)) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200).end();
      this.log("asked to shut down");
      void this.stop();
      return;
    }
    response.writeHead(404).end();
  }

  private onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const refuse = () => {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
    };
    if (!this.isLoopbackHost(request)) return refuse();
    if (pathname === RelayPaths.extension) {
      if (!/^moz-extension:\/\/[0-9a-f-]+$/i.test(request.headers.origin ?? "")) return refuse();
      this.wss.handleUpgrade(request, socket, head, (ws) => this.extension.accept(ws));
      return;
    }
    if (pathname === RelayPaths.client) {
      if (request.headers.origin || !this.hasToken(request)) return refuse();
      this.wss.handleUpgrade(request, socket, head, (ws) => this.onClient(ws));
      return;
    }
    refuse();
  }

  private onClient(ws: WebSocket) {
    this.clients.add(ws);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const dropped = () => {
      this.clients.delete(ws);
      this.scheduleIdleExit();
    };
    ws.on("close", dropped);
    ws.once("message", (data) => {
      let hello: ClientHello;
      try {
        hello = JSON.parse(data.toString()) as ClientHello;
      } catch {
        ws.close();
        return;
      }
      if (hello.type !== "hello" || hello.protocol !== CLIENT_PROTOCOL_VERSION) {
        ws.close(4001, "Update the MCP server");
        return;
      }
      this.startSession(ws, hello);
    });
  }

  private startSession(ws: WebSocket, hello: ClientHello) {
    const sessionId = randomUUID();
    const welcome: DaemonWelcome = { type: "welcome", protocol: CLIENT_PROTOCOL_VERSION, version: this.options.version, sessionId };
    const peer = new RpcPeer<DaemonToClientMethods, ClientToDaemonMethods>(ws, {
      "tools/list": async () => this.engine.listTools(),
      "tools/call": async ({ name, arguments: args }) => this.engine.callTool(session, name, args),
    }, () => {
      void this.engine.removeSession(sessionId);
      this.log("session ended", hello.client.name);
    });
    const session = this.engine.addSession(sessionId, hello.client, {
      readFile: (path) => peer.request("readFile", { path }),
      writeFile: async (path, base64) => (await peer.request("writeFile", { path, base64 })).path,
    });
    ws.send(JSON.stringify(welcome));
    this.log("session started", hello.client.name);
  }

  private scheduleIdleExit() {
    if (this.clients.size || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.log("no AI apps for a while: exiting");
      void this.stop();
    }, this.options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS);
    this.idleTimer.unref?.();
  }
}

/** The thin process's connection to the daemon, made on demand: finds it, starts it, and replaces an outdated one */
import { spawn } from "node:child_process";
import { RelayPaths } from "../protocol";
import WebSocket from "ws";

import {
  CLIENT_PROTOCOL_VERSION,
  type ClientHello,
  type ClientToDaemonMethods,
  type DaemonInfo,
  type DaemonToClientMethods,
  type DaemonWelcome,
} from "./contracts";
import { sleep } from "./output";
import { daemonInfoPath, daemonLogPath, fetchStatus, RELAY_HOST, readDaemonInfo } from "./paths";
import { RpcPeer, type RpcHandlers, TOOL_CALL_TIMEOUT_MS } from "./rpc";
import { compareVersions } from "./version";

export type DaemonClientOptions = {
  home: string;
  port?: number;
  version: string;
  /** `[node, <package>/dist/server/daemon.js]`; `--port` is appended */
  daemonCommand: string[];
  client(): ClientHello["client"];
  files: RpcHandlers<DaemonToClientMethods>;
  log(...args: unknown[]): void;
};

type Peer = RpcPeer<ClientToDaemonMethods, DaemonToClientMethods>;

const START_TIMEOUT_MS = 15_000;

export class DaemonClient {
  private peer: Peer | null = null;
  private connecting: Promise<Peer> | null = null;

  constructor(private readonly options: DaemonClientOptions) {}

  async call<M extends keyof ClientToDaemonMethods & string>(method: M, params: ClientToDaemonMethods[M]["params"]): Promise<ClientToDaemonMethods[M]["result"]> {
    const peer = await this.connect();
    return (await peer.request(method, params as never, {
      ...(method === "tools/call" ? { timeoutMs: TOOL_CALL_TIMEOUT_MS } : {}),
    })) as ClientToDaemonMethods[M]["result"];
  }

  close() {
    this.peer?.close();
    this.peer = null;
  }

  connect(): Promise<Peer> {
    if (this.peer?.open) return Promise.resolve(this.peer);
    this.connecting ??= this.findOrStart().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async findOrStart(): Promise<Peer> {
    const { log, version } = this.options;
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      const found = await this.findDaemon();
      if (!found) {
        await this.startDaemon();
        continue;
      }
      // A rebuilt or newer server replaces the daemon; an older one uses what's there
      if (found.version !== version && compareVersions(version, found.version) >= 0) {
        log(`Replacing the daemon ${found.version} with ${version}`);
        await this.replace(found.info);
        continue;
      }
      try {
        this.peer = await this.open(found.info);
        return this.peer;
      } catch (error) {
        lastError = error;
        log("Couldn't connect to the daemon:", error);
      }
    }
    throw new Error(`Couldn't start the MCP for Firefox daemon (see ${daemonLogPath(this.options.home)})${lastError ? `: ${String(lastError)}` : ""}`);
  }

  private async findDaemon(): Promise<{ info: DaemonInfo; version: string } | null> {
    const info = readDaemonInfo(daemonInfoPath(this.options.home, this.options.port));
    if (!info) return null;
    const status = await fetchStatus(info.port);
    return status && status.pid === info.pid ? { info, version: status.version } : null;
  }

  private async startDaemon() {
    const [command, ...args] = this.options.daemonCommand;
    if (this.options.port) args.push("--port", String(this.options.port));
    this.options.log("Starting the daemon");
    const child = spawn(command!, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, FIREFOX_MCP_HOME: this.options.home },
    });
    child.on("error", (error) => this.options.log("Couldn't spawn the daemon:", error));
    child.unref();
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await this.findDaemon()) return;
      await sleep(100);
    }
  }

  private async replace(info: DaemonInfo) {
    try {
      await fetch(`http://${RELAY_HOST}:${info.port}${RelayPaths.shutdown}?token=${encodeURIComponent(info.token)}`, {
        method: "POST",
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      // It's already going
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const status = await fetchStatus(info.port, 300);
      if (!status || status.pid !== info.pid) return;
      await sleep(100);
    }
  }

  private open(info: DaemonInfo): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://${RELAY_HOST}:${info.port}${RelayPaths.client}?token=${encodeURIComponent(info.token)}`, { maxPayload: 100 * 1024 * 1024 });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("The daemon didn't welcome this connection"));
      }, 10_000);
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("open", () => {
        const hello: ClientHello = {
          type: "hello",
          protocol: CLIENT_PROTOCOL_VERSION,
          version: this.options.version,
          client: this.options.client(),
          pid: process.pid,
        };
        socket.send(JSON.stringify(hello));
      });
      socket.once("message", (data) => {
        clearTimeout(timer);
        const welcome = JSON.parse(data.toString()) as DaemonWelcome;
        if (welcome.type !== "welcome") {
          socket.close();
          reject(new Error("The daemon answered with something else"));
          return;
        }
        resolve(new RpcPeer<ClientToDaemonMethods, DaemonToClientMethods>(socket, this.options.files, () => {
          this.peer = null;
        }));
      });
      socket.once("close", (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`The daemon closed the connection (${code} ${reason.toString()})`));
      });
    });
  }
}

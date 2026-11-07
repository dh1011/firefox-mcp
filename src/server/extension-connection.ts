/** The daemon's side of the connection to the extension: the handshake, pairing, and the requests it sends */
import type WebSocket from "ws";

import {
  type BrowserMethod,
  type BrowserMethods,
  type DaemonMessage,
  type ExtensionMessage,
  NO_EXTENSION_MESSAGE,
  pairingCode,
  pairingCommitment,
  pairingPayload,
  pairingRequiredMessage,
  PAUSED_MESSAGE,
  randomNonce,
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
} from "../protocol";
import type { BrowserBackend, DaemonIdentity } from "./contracts";
import { signPayload } from "./paths";

/** How long a browser may take to show up right after the daemon starts or one disconnects: it retries every 2 s */
const EXPECTED_MS = 4000;
const CALL_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 20_000;

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

/** One socket's life, from `hello` to close */
class ExtensionSocket {
  pairing: "paired" | "pending" | null = null;
  paused = false;
  code: string | undefined;
  private daemonNonce = "";
  private revealed = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    readonly socket: WebSocket,
    private readonly identity: DaemonIdentity,
    private readonly port: number,
    private readonly version: string,
    private readonly onState: () => void,
    private readonly log: (...args: unknown[]) => void,
  ) {}

  async handle(raw: string) {
    let message: ExtensionMessage;
    try {
      message = JSON.parse(raw) as ExtensionMessage;
    } catch {
      return;
    }
    if ("id" in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    switch (message.type) {
      case "hello":
        await this.welcome(message.protocol, message.challenge);
        return;
      case "pairingNonce":
        // Once per connection: the commitment holds only if the daemon can't be asked to reveal twice
        if (!this.revealed && typeof message.nonce === "string") {
          this.revealed = true;
          this.code = await pairingCode(this.identity.publicKey, message.nonce, this.daemonNonce);
          this.send({ type: "pairingReveal", nonce: this.daemonNonce });
          this.onState();
        }
        return;
      case "state":
        this.pairing = message.pairing;
        this.paused = message.paused;
        if (message.pairing === "paired") this.code = undefined;
        this.onState();
        return;
    }
  }

  private async welcome(protocol: unknown, challenge: unknown) {
    if (protocol !== RELAY_PROTOCOL_VERSION) {
      const side = typeof protocol === "number" && protocol > RELAY_PROTOCOL_VERSION ? "the MCP server" : "the extension";
      this.socket.close(RelayCloseCode.unsupportedProtocol, `Update ${side}: they speak different protocol versions`);
      return;
    }
    if (typeof challenge !== "string" || !challenge) {
      this.socket.close(RelayCloseCode.unsupportedProtocol, "The hello had no challenge");
      return;
    }
    this.daemonNonce = randomNonce();
    const commitment = await pairingCommitment(this.daemonNonce);
    this.send({
      type: "welcome",
      protocol: RELAY_PROTOCOL_VERSION,
      version: this.version,
      publicKey: this.identity.publicKey,
      signature: signPayload(this.identity, pairingPayload(challenge, this.port, commitment)),
      pairingCommitment: commitment,
    });
  }

  call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The browser didn't answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  closed() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("The browser disconnected"));
    }
    this.pending.clear();
    this.log("extension disconnected");
  }

  private send(message: DaemonMessage) {
    if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(message));
  }
}

export class ExtensionConnection implements BrowserBackend {
  private current: ExtensionSocket | null = null;
  private expectedUntil: number;
  private readonly waiters = new Set<() => void>();

  constructor(
    private readonly identity: DaemonIdentity,
    private readonly port: () => number,
    private readonly version: string,
    private readonly log: (...args: unknown[]) => void,
    /** A browser connected: it knows of none of the tabs anything claimed */
    private readonly onBrowserChange: () => void,
  ) {
    this.expectedUntil = Date.now() + EXPECTED_MS;
  }

  /** Takes a new socket on `/extension`. A second browser waits its turn, unless the current one never got paired */
  accept(socket: WebSocket) {
    if (this.current?.pairing === "paired") {
      socket.close(RelayCloseCode.anotherBrowser, "Another browser is connected");
      return;
    }
    this.current?.socket.close();
    const connection = new ExtensionSocket(socket, this.identity, this.port(), this.version, () => this.stateChanged(), this.log);
    this.current = connection;
    this.onBrowserChange();
    socket.on("message", (data) => void connection.handle(data.toString()));
    const ping = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, PING_INTERVAL_MS);
    const closed = () => {
      clearInterval(ping);
      connection.closed();
      if (this.current === connection) {
        this.current = null;
        this.expectedUntil = Date.now() + EXPECTED_MS;
      }
    };
    socket.on("close", closed);
    socket.on("error", (error) => this.log("extension socket error", error));
    this.log("extension connected");
  }

  private stateChanged() {
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }

  unavailableReason(): string | null {
    const current = this.current;
    if (!current) return NO_EXTENSION_MESSAGE;
    if (current.pairing !== "paired") return pairingRequiredMessage(current.code);
    if (current.paused) return PAUSED_MESSAGE;
    return null;
  }

  async whenReady(): Promise<void> {
    while (this.current?.pairing === null || (!this.current && Date.now() < this.expectedUntil)) {
      const remaining = this.current ? 2000 : this.expectedUntil - Date.now();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.waiters.delete(done);
          resolve();
        }, Math.min(remaining, 100));
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.add(done);
      });
      if (this.current?.pairing === null && Date.now() > this.expectedUntil + 2000) return;
    }
  }

  call<M extends BrowserMethod>(method: M, params: BrowserMethods[M]["params"], timeoutMs = CALL_TIMEOUT_MS): Promise<BrowserMethods[M]["result"]> {
    const current = this.current;
    if (!current) return Promise.reject(new Error(NO_EXTENSION_MESSAGE));
    return current.call(method, params, timeoutMs) as Promise<BrowserMethods[M]["result"]>;
  }
}

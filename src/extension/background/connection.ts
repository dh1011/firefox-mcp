/**
 * The connection to the daemon. Being a persistent background page, it keeps the socket open for as long as Firefox
 * runs. Requests only reach the tabs after the user paired this daemon's key and while they haven't pressed Stop.
 */
import {
  type BrowserInfo,
  type DaemonMessage,
  type ExtensionMessage,
  isValidRelayPort,
  NO_EXTENSION_MESSAGE,
  pairingRequiredMessage,
  PAUSED_MESSAGE,
  PRODUCT,
  randomNonce,
  RELAY_PORTS,
  RELAY_PROTOCOL_VERSION,
  RelayCloseCode,
  RelayPaths,
  type RelayStatus,
  revealedPairingCode,
  verifyDaemonSignature,
} from "../../protocol";

const RETRY_MS = 2000;
const PROBE_TIMEOUT_MS = 1000;

export type ConnectionStatus =
  | "searching"
  | "connecting"
  /** Waiting for the user to click Allow */
  | "pending"
  | "connected"
  /** A program on the port failed to prove it holds the key it claims */
  | "untrusted"
  | "anotherBrowser"
  | "outdated";

export type ConnectionState = {
  status: ConnectionStatus;
  paused: boolean;
  /** The pairing code, while pending */
  code: string | null;
  port: number | null;
  /** What to tell the user about `untrusted` and `outdated` */
  detail: string | null;
  /** The port the user set, instead of the default ones */
  customPort: number | null;
};

type Stored = {
  pairedKeys?: string[];
  paused?: boolean;
  customPort?: number;
};

export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

export class Connection {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = "searching";
  private detail: string | null = null;
  private code: string | null = null;
  private port: number | null = null;
  private publicKey: string | null = null;
  private paused = false;
  private customPort: number | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(
    private readonly browserInfo: BrowserInfo,
    private readonly version: string,
    private readonly onRequest: RequestHandler,
    private readonly onChange: (state: ConnectionState) => void,
    /** A new daemon knows nothing of the tabs the last one claimed */
    private readonly onDaemonChange: () => void,
  ) {}

  async start() {
    const stored = (await browser.storage.local.get(["paused", "customPort"])) as Stored;
    this.paused = !!stored.paused;
    this.customPort = stored.customPort ?? null;
    this.changed();
    void this.search();
  }

  state(): ConnectionState {
    return {
      status: this.status,
      paused: this.paused,
      code: this.code,
      port: this.port,
      detail: this.detail,
      customPort: this.customPort,
    };
  }

  private changed() {
    this.onChange(this.state());
  }

  private setStatus(status: ConnectionStatus, detail: string | null = null) {
    this.status = status;
    this.detail = detail;
    this.changed();
  }

  /** The user clicked Allow */
  async allow() {
    if (this.status !== "pending" || !this.publicKey) return;
    const { pairedKeys = [] } = (await browser.storage.local.get("pairedKeys")) as Stored;
    if (!pairedKeys.includes(this.publicKey)) {
      await browser.storage.local.set({ pairedKeys: [...pairedKeys, this.publicKey] });
    }
    this.code = null;
    this.setStatus("connected");
    this.sendState();
  }

  /** Forgets every paired daemon: the next connection asks again */
  async forgetPairings() {
    await browser.storage.local.remove("pairedKeys");
    this.reconnect();
  }

  async setPaused(paused: boolean) {
    this.paused = paused;
    await browser.storage.local.set({ paused });
    this.changed();
    this.sendState();
  }

  async setCustomPort(port: number | null) {
    if (port !== null && !isValidRelayPort(port)) return;
    this.customPort = port;
    if (port === null) await browser.storage.local.remove("customPort");
    else await browser.storage.local.set({ customPort: port });
    this.reconnect();
  }

  reconnect() {
    this.socket?.close();
    this.socket = null;
    this.generation++;
    this.code = null;
    this.publicKey = null;
    this.port = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.setStatus("searching");
    void this.search();
  }

  private ports(): readonly number[] {
    return this.customPort ? [this.customPort] : RELAY_PORTS;
  }

  private retry() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.search(), RETRY_MS);
  }

  private async search() {
    const generation = this.generation;
    for (const port of this.ports()) {
      if (generation !== this.generation || this.socket) return;
      if (await this.probe(port)) {
        if (generation !== this.generation || this.socket) return;
        this.open(port);
        return;
      }
    }
    this.retry();
  }

  private async probe(port: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${RelayPaths.status}`, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        cache: "no-store",
        credentials: "omit",
      });
      const status = (await response.json()) as RelayStatus;
      return status.product === PRODUCT;
    } catch {
      return false;
    }
  }

  private open(port: number) {
    const generation = this.generation;
    const socket = new WebSocket(`ws://127.0.0.1:${port}${RelayPaths.extension}`);
    this.socket = socket;
    this.port = port;
    if (this.status !== "untrusted" && this.status !== "anotherBrowser" && this.status !== "outdated") {
      this.setStatus("connecting");
    }
    const challenge = randomNonce();
    let commitment = "";
    let extensionNonce = "";
    let publicKey = "";

    socket.onopen = () => {
      this.send({
        type: "hello",
        protocol: RELAY_PROTOCOL_VERSION,
        version: this.version,
        challenge,
        browser: this.browserInfo,
      });
    };

    socket.onmessage = async (event) => {
      if (generation !== this.generation) return;
      let message: DaemonMessage;
      try {
        message = JSON.parse(String(event.data)) as DaemonMessage;
      } catch {
        return;
      }
      if ("type" in message) {
        if (message.type === "welcome") {
          const verified = await verifyDaemonSignature({
            challenge,
            port,
            publicKey: message.publicKey,
            commitment: message.pairingCommitment,
            signature: message.signature,
          });
          if (generation !== this.generation) return;
          if (!verified) {
            this.untrusted(socket);
            return;
          }
          publicKey = message.publicKey;
          commitment = message.pairingCommitment;
          this.onDaemonChange();
          const { pairedKeys = [] } = (await browser.storage.local.get("pairedKeys")) as Stored;
          if (generation !== this.generation) return;
          if (pairedKeys.includes(publicKey)) {
            this.publicKey = publicKey;
            this.code = null;
            this.setStatus("connected");
            this.sendState();
          } else {
            extensionNonce = randomNonce();
            this.send({ type: "pairingNonce", nonce: extensionNonce });
          }
        } else if (message.type === "pairingReveal") {
          const code = await revealedPairingCode({
            publicKey,
            commitment,
            extensionNonce,
            daemonNonce: message.nonce,
          });
          if (generation !== this.generation) return;
          if (!code) {
            this.untrusted(socket);
            return;
          }
          this.publicKey = publicKey;
          this.code = code;
          this.setStatus("pending");
          this.sendState();
        }
        return;
      }
      void this.handleRequest(message);
    };

    socket.onclose = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.socket = null;
      this.code = null;
      this.publicKey = null;
      this.port = null;
      this.onDaemonChange();
      if (event.code === RelayCloseCode.anotherBrowser) {
        this.setStatus("anotherBrowser");
      } else if (event.code === RelayCloseCode.unsupportedProtocol) {
        this.setStatus("outdated", event.reason || "Update the extension and the MCP server to the same version");
      } else if (this.status !== "untrusted") {
        this.setStatus("searching");
      }
      this.retry();
    };
  }

  private untrusted(socket: WebSocket) {
    this.setStatus("untrusted", "A program on the extension's port failed to prove its identity, so it was refused");
    socket.close(RelayCloseCode.untrusted);
  }

  private async handleRequest(message: { id: number; method: string; params: unknown }) {
    const { id, method, params } = message;
    try {
      if (this.status === "pending") {
        throw new Error(pairingRequiredMessage(this.code ?? undefined));
      }
      if (this.status !== "connected") throw new Error(NO_EXTENSION_MESSAGE);
      if (this.paused) throw new Error(PAUSED_MESSAGE);
      this.send({ id, result: await this.onRequest(method, params) });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.send({ id, error: { message: text } });
    }
  }

  private sendState() {
    this.send({
      type: "state",
      pairing: this.status === "connected" ? "paired" : "pending",
      paused: this.paused,
    });
  }

  private send(message: ExtensionMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}

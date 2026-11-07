/**
 * The interfaces between the server's layers:
 *
 * ```
 * AI app ──stdio──▶ thin process ──ws /client──▶ daemon ──ws /extension──▶ extension ──▶ content scripts
 *                                                 └─ engine (commands, sessions)
 * ```
 *
 * One daemon runs per user, so several AI apps can share the browser's one connection.
 */
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import type { BrowserMethod, BrowserMethods, UploadFile } from "../protocol";

/** Bumped on breaking changes between the thin process and the daemon */
export const CLIENT_PROTOCOL_VERSION = 1;

/** `identity.json`: the daemon's key pair, kept across restarts so the extension's pairing survives them */
export type DaemonIdentity = {
  /** Base64 SPKI (DER) */
  publicKey: string;
  /** PKCS #8 PEM */
  privateKey: string;
};

/** `daemon.json`, written once the daemon listens */
export type DaemonInfo = {
  port: number;
  pid: number;
  version: string;
  /** Required on `/client` and `/shutdown` */
  token: string;
};

export type ClientHello = {
  type: "hello";
  protocol: number;
  version: string;
  /** The MCP client, which names the session's tab group */
  client: { name: string; title?: string; version?: string };
  pid: number;
};

export type DaemonWelcome = {
  type: "welcome";
  protocol: number;
  version: string;
  sessionId: string;
};

export type ClientToDaemonMethods = {
  "tools/list": { params: Record<string, never>; result: { tools: Tool[] } };
  "tools/call": {
    params: { name: string; arguments?: Record<string, unknown> };
    result: CallToolResult;
  };
};

/** The thin process touches files, since it runs where the AI app does and paths are the AI app's */
export type DaemonToClientMethods = {
  readFile: { params: { path: string }; result: UploadFile };
  writeFile: { params: { path: string; base64: string }; result: { path: string } };
};

export type SessionIO = {
  readFile(path: string): Promise<UploadFile>;
  writeFile(path: string, base64: string): Promise<string>;
};

/** What the engine needs from the browser. The extension connection implements it, and tests can fake it */
export interface BrowserBackend {
  /** A message for the model when no usable browser is connected, else null */
  unavailableReason(): string | null;
  /** Waits briefly for a browser that's expected any moment: right after the daemon started or one disconnected */
  whenReady(): Promise<void>;
  call<M extends BrowserMethod>(
    method: M,
    params: BrowserMethods[M]["params"],
    timeoutMs?: number,
  ): Promise<BrowserMethods[M]["result"]>;
}

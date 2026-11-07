import { randomBytes, sign, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { PRODUCT, RelayPaths, type RelayStatus } from "../protocol";
import type { DaemonIdentity, DaemonInfo } from "./contracts";

export const RELAY_HOST = "127.0.0.1";

export function mcpHome(): string {
  return process.env.FIREFOX_MCP_HOME || path.join(homedir(), ".firefox-mcp");
}

function suffix(port: number | undefined) {
  return port ? `-${port}` : "";
}

export function daemonInfoPath(home: string, port?: number) {
  return path.join(home, `daemon${suffix(port)}.json`);
}

export function daemonLockPath(home: string, port?: number) {
  return path.join(home, `daemon${suffix(port)}.lock`);
}

export function daemonLogPath(home: string) {
  return path.join(home, "daemon.log");
}

export function ensureHome(home: string) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

/** Written whole, readable only by the user: it holds the token or the private key */
export function writePrivateFile(file: string, contents: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps a profile's files private through its ACLs
  }
}

export function readDaemonInfo(file: string): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(file, "utf8")) as DaemonInfo;
    return typeof info.port === "number" && typeof info.token === "string" ? info : null;
  } catch {
    return null;
  }
}

export async function fetchStatus(port: number, timeoutMs = 1000): Promise<RelayStatus | null> {
  try {
    const response = await fetch(`http://${RELAY_HOST}:${port}${RelayPaths.status}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const status = (await response.json()) as RelayStatus;
    return status.product === PRODUCT ? status : null;
  } catch {
    return null;
  }
}

/** The daemon's key pair, made on first start and kept, so the extension's pairing survives restarts and updates */
export function loadIdentity(home: string): DaemonIdentity {
  const file = path.join(home, "identity.json");
  try {
    const identity = JSON.parse(readFileSync(file, "utf8")) as DaemonIdentity;
    if (identity.publicKey && identity.privateKey) return identity;
  } catch {
    // None yet
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const identity: DaemonIdentity = {
    publicKey: (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  };
  writePrivateFile(file, JSON.stringify(identity));
  return identity;
}

export function signPayload(identity: DaemonIdentity, payload: string): string {
  return sign("sha256", Buffer.from(payload), {
    key: identity.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
}

export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

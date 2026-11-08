/**
 * The protocol between the extension and the daemon, shared by both.
 *
 * The extension probes `GET http://127.0.0.1:<port>/firefox-mcp/status` on each of `RELAY_PORTS`, opens
 * `ws://127.0.0.1:<port>/extension` and sends `hello` with a random challenge. The daemon answers `welcome` with its
 * public key and a signature of the challenge. Frames are JSON objects.
 *
 * Pairing is a short authentication string built with a commitment (see NOTICE), because a program that takes over
 * the port must not get to drive the browser.
 *
 * 1. `hello` (extension → daemon) carries a random `challenge`.
 * 2. `welcome` (daemon → extension) carries `pairingCommitment`, the SHA-256 of a nonce the daemon made for this
 *    connection, and the signature of `pairingPayload(challenge, port, pairingCommitment)`.
 * 3. For a key it hasn't paired with, the extension sends `pairingNonce` with a nonce of its own.
 * 4. The daemon answers `pairingReveal` with its nonce, which the extension checks against the commitment.
 * 5. Both sides compute `pairingCode(publicKey, extensionNonce, daemonNonce)` and the user compares them.
 *
 * The order is what makes six digits enough: the daemon commits before it sees the extension's nonce, and the
 * extension sends its nonce before the daemon reveals, so a program in the middle can't steer the two codes together.
 *
 * The extension enforces every rule about tabs itself, so a program that takes over the port can't drive the browser.
 * It can still pose as the daemon to AI apps, or as the extension to the daemon: the README's Security section says so.
 */

export const PRODUCT = "firefox-mcp";
export const PRODUCT_NAME = "MCP for Firefox";

/** Bumped on breaking changes between the extension and the daemon */
export const RELAY_PROTOCOL_VERSION = 1;

/** The ports the daemon binds (the first free one) and the extension tries, in order */
export const RELAY_PORTS = [9320, 9321, 9322] as const;

export const RelayPaths = {
  status: `/${PRODUCT}/status`,
  extension: "/extension",
  client: "/client",
  shutdown: "/shutdown",
} as const;

export const RelayCloseCode = {
  /** The other side speaks another protocol version; the reason says which side to update */
  unsupportedProtocol: 4001,
  /** Another browser (profile) is connected and paired */
  anotherBrowser: 4002,
  /** The daemon failed to prove its identity */
  untrusted: 4003,
} as const;

export function isValidRelayPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

/** What `/firefox-mcp/status` answers */
export type RelayStatus = {
  product: typeof PRODUCT;
  protocol: number;
  version: string;
  pid: number;
};

// --- Pairing ---

/** ECDSA P-256: in WebCrypto and Node. Keys are base64 SPKI; signatures base64 IEEE P1363 over SHA-256 */
export const PAIRING_KEY_ALGORITHM = {
  name: "ECDSA",
  namedCurve: "P-256",
  hash: "SHA-256",
} as const;

/**
 * The bytes the daemon signs. It names the port, so a program holding another of `RELAY_PORTS` can't relay the
 * challenge to the real daemon and pass its signature back, and it covers the commitment, so only the key's holder
 * commits to the nonce behind the pairing code
 */
export function pairingPayload(
  challenge: string,
  port: number,
  commitment: string,
): string {
  return `${PRODUCT}-pair-v1:${port}:${challenge}:${commitment}`;
}

/** Base64 of 32 random bytes */
export function randomNonce(): string {
  return toBase64(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function pairingCommitment(daemonNonce: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    fromBase64(daemonNonce),
  );
  return toBase64(new Uint8Array(digest));
}

/** The six-digit code the popup shows next to Allow and tool results repeat, e.g. `482 913`. Fresh per connection */
export async function pairingCode(
  publicKey: string,
  extensionNonce: string,
  daemonNonce: string,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${PRODUCT}-pair-code-v1:${publicKey}:${extensionNonce}:${daemonNonce}`,
    ),
  );
  const digits = String(
    new DataView(digest).getUint32(0, false) % 1_000_000,
  ).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** Whether `signature` proves the daemon holds `publicKey`, for this challenge, port and commitment */
export async function verifyDaemonSignature(options: {
  challenge: string;
  port: number;
  publicKey: string;
  commitment: string;
  signature: string;
}): Promise<boolean> {
  const { challenge, port, publicKey, commitment, signature } = options;
  if (!commitment || typeof commitment !== "string") return false;
  try {
    const key = await globalThis.crypto.subtle.importKey(
      "spki",
      fromBase64(publicKey),
      {
        name: PAIRING_KEY_ALGORITHM.name,
        namedCurve: PAIRING_KEY_ALGORITHM.namedCurve,
      },
      false,
      ["verify"],
    );
    return await globalThis.crypto.subtle.verify(
      { name: PAIRING_KEY_ALGORITHM.name, hash: PAIRING_KEY_ALGORITHM.hash },
      key,
      fromBase64(signature),
      new TextEncoder().encode(pairingPayload(challenge, port, commitment)),
    );
  } catch {
    return false;
  }
}

/** The code to show once the daemon revealed its nonce, or `null` when the reveal doesn't match its commitment */
export async function revealedPairingCode(options: {
  publicKey: string;
  commitment: string;
  extensionNonce: string;
  daemonNonce: unknown;
}): Promise<string | null> {
  const { publicKey, commitment, extensionNonce, daemonNonce } = options;
  try {
    if (
      typeof daemonNonce !== "string" ||
      (await pairingCommitment(daemonNonce)) !== commitment
    ) {
      return null;
    }
    return await pairingCode(publicKey, extensionNonce, daemonNonce);
  } catch {
    return null;
  }
}

export function pairingRequiredMessage(code?: string): string {
  const message = `Ask the user to click Allow in the ${PRODUCT_NAME} toolbar popup in Firefox`;
  return code
    ? `${message}. The popup should show the code ${code}: tell the user to check that it matches`
    : message;
}

export const NO_EXTENSION_MESSAGE = `No browser is connected. Ask the user to start Firefox with the ${PRODUCT_NAME} extension installed and enabled`;

export const PAUSED_MESSAGE = `The user pressed Stop in the ${PRODUCT_NAME} popup. Ask them to press Resume when you may use the browser again`;

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// --- Frames ---

export type BrowserInfo = { name: string; version: string };

export type ExtensionMessage =
  | {
      type: "hello";
      protocol: number;
      version: string;
      challenge: string;
      browser: BrowserInfo;
    }
  | { type: "pairingNonce"; nonce: string }
  | { type: "state"; pairing: "paired" | "pending"; paused: boolean }
  | { id: number; result: unknown }
  | { id: number; error: { message: string } };

export type DaemonMessage =
  | {
      type: "welcome";
      protocol: number;
      version: string;
      publicKey: string;
      signature: string;
      pairingCommitment: string;
    }
  | { type: "pairingReveal"; nonce: string }
  | { id: number; method: string; params: unknown };

// --- What the daemon asks of the extension ---

/** An AI app, which names its tab group */
export type AppInfo = { id: string; name: string };

export type TabInfo = {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  pinned: boolean;
  windowId: number;
  loading: boolean;
};

/** A locator argument. Regexes travel as objects, since frames are JSON */
export type Literal =
  | string
  | number
  | boolean
  | { regex: string; flags: string }
  | { [key: string]: string | number | boolean | { regex: string; flags: string } };

export type LocatorCall = { method: string; args: Literal[] };

export type Target =
  | { kind: "ref"; ref: string; source: string }
  | { kind: "locator"; calls: LocatorCall[]; source: string }
  | { kind: "css"; selector: string; source: string };

/** A node of the accessibility snapshot. `ref`s are `e12`, or `f1e3` in an iframe */
export type AriaNode = {
  role: string;
  name?: string;
  /** Text under a text-only element, or a field's value */
  text?: string;
  ref?: string;
  url?: string;
  level?: number;
  value?: string;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  readonly?: boolean;
  invalid?: boolean;
  active?: boolean;
  cursor?: "pointer";
  /** An iframe's frame, until the extension grafts in its tree */
  frameId?: number;
  children?: AriaNode[];
};

export type ConsoleEntry = {
  seq: number;
  /** `log`, `info`, `warn`, `error`, `debug`, or `uncaught` */
  type: string;
  text: string;
  location?: string;
};

export type RequestEntry = {
  id: number;
  method: string;
  url: string;
  type: string;
  status: number | null;
  statusLine?: string;
  failure?: string;
  /** `name: value` pairs, with secrets hidden */
  requestHeaders?: [string, string][];
  responseHeaders?: [string, string][];
  postData?: string;
  body?: string;
  bodyNote?: string;
};

export type DialogEntry = {
  kind: "alert" | "confirm" | "prompt";
  message: string;
  /** How it was answered */
  answer: string;
  /** No `dialog` command was waiting for it */
  automatic: boolean;
};

/** What happened around an action: a settle result, and what the page did meanwhile */
export type ActionOutcome = {
  value?: unknown;
  /** The navigation it started hasn't finished */
  stillLoading?: boolean;
  url?: string;
  title?: string;
  opened?: { tabId: number; url: string }[];
  dialogs?: DialogEntry[];
  /** The navigation it started failed */
  navError?: string;
  /** Console errors and uncaught errors so far in this tab */
  errorCount?: number;
  lastError?: string;
};

export type UploadFile = { name: string; mimeType: string; base64: string };

export type Metrics = {
  scrollX: number;
  scrollY: number;
  width: number;
  height: number;
  scrollWidth: number;
  scrollHeight: number;
  dpr: number;
};

export type ScreenshotRequest =
  | { kind: "viewport" }
  | { kind: "full" }
  | { kind: "element"; target: Target };

export type BrowserMethods = {
  "tabs.list": { params: Record<string, never>; result: { tabs: TabInfo[] } };
  "tabs.get": { params: { tabId: number }; result: { tab: TabInfo | null } };
  /** A new background tab on `about:blank`, claimed, so its first page has the hooks and its requests are tracked */
  "tabs.create": { params: { app: AppInfo }; result: { tabId: number } };
  /** Starts driving the tab: scripts, hooks and request tracking, and the app's tab group */
  "tabs.claim": { params: { tabId: number; app: AppInfo }; result: object };
  "tabs.release": { params: { tabId: number }; result: object };
  "tabs.releaseAll": { params: Record<string, never>; result: object };
  "tabs.close": { params: { tabId: number }; result: object };
  "tabs.activate": { params: { tabId: number }; result: object };
  "page.navigate": {
    params: {
      tabId: number;
      kind: "goto" | "back" | "forward" | "reload";
      url?: string;
    };
    result: ActionOutcome;
  };
  /** Runs a content-script operation, with a target if it has one, waiting up to `timeoutMs` for it to be possible */
  "page.op": {
    params: {
      tabId: number;
      op: string;
      target?: Target;
      args?: Record<string, unknown>;
      timeoutMs?: number;
      /** Waits for what the action started (navigations, requests), and reports what the page did */
      settle?: boolean;
    };
    result: ActionOutcome;
  };
  /** Sums a count over the tab's frames */
  "page.count": {
    params: {
      tabId: number;
      target: Target;
      visibleOnly?: boolean;
    };
    result: { count: number };
  };
  "page.snapshot": {
    params: { tabId: number };
    result: { nodes: AriaNode[] };
  };
  "page.screenshot": {
    params: { tabId: number; request: ScreenshotRequest; maxSide: number };
    result: { dataUrl: string; width: number; height: number };
  };
  "page.console": {
    params: { tabId: number };
    result: { entries: ConsoleEntry[] };
  };
  "page.requests": {
    params: { tabId: number };
    result: { entries: RequestEntry[] };
  };
  "page.request": {
    params: { tabId: number; id: number };
    result: { entry: RequestEntry | null };
  };
  /** How the next dialog is answered */
  "page.dialogPolicy": {
    params: { tabId: number; accept: boolean; text?: string };
    result: object;
  };
};

export type BrowserMethod = keyof BrowserMethods;

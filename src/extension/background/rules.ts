/**
 * Which pages agents may use. These rules live in the extension, not the daemon, so they hold whatever program is on
 * the other end of the connection.
 */

/** `extensions.webextensions.restrictedDomains`: Firefox doesn't let extensions script these */
const RESTRICTED_HOSTS = new Set([
  "accounts-static.cdn.mozilla.net",
  "accounts.firefox.com",
  "addons.cdn.mozilla.net",
  "addons.mozilla.org",
  "api.accounts.firefox.com",
  "content.cdn.mozilla.net",
  "discovery.addons.mozilla.org",
  "install.mozilla.org",
  "oauth.accounts.firefox.com",
  "profile.accounts.firefox.com",
  "support.mozilla.org",
  "sync.services.mozilla.com",
]);

/** Web pages and `about:blank` (where new tabs start). Never browser pages, extension pages or local files */
export function isExposedUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url === "about:blank") return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // `addons.mozilla.org.` is the same site, and Firefox's own restriction misses it
  return !RESTRICTED_HOSTS.has(parsed.hostname.replace(/\.+$/, ""));
}

export function refusedUrlMessage(url: string): string {
  return `Agents can't use ${url}: only web pages (http and https), not browser pages, extension pages, local files or Mozilla's add-on and account sites`;
}

// --- Credentials in what agents read ---

const HIDDEN = "(hidden)";

/** Parts of a name that mean it holds a credential: `X-Auth-Token`, `x-csrftoken`, `client_secret`, `user[password]` */
const SECRET_NAME =
  /authoriz|token|secret|passw|pwd|session|sessid|cookie|csrf|xsrf|api[-_]?key|access[-_]?key|private[-_]?key|signature|credential|[-_]auth$/i;
/** Short names that hold credentials when they're the whole name */
const SECRET_NAMES = new Set(["code", "key", "sig", "sid", "pass", "pin", "otp", "jwt", "auth"]);
/** Names that match but hold nothing secret, and help with debugging */
const PUBLIC_NAMES = new Set(["www-authenticate", "proxy-authenticate", "access-control-allow-credentials"]);
/** Headers whose value is a URL, which can carry credentials in its parameters */
const URL_HEADERS = new Set(["referer", "location", "content-location", "refresh"]);

/** Whether a header, URL parameter, form field or JSON key is named like a credential */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  if (PUBLIC_NAMES.has(lower)) return false;
  return SECRET_NAMES.has(lower) || SECRET_NAME.test(lower);
}

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

/** `a=1&password=2` → `a=1&password=(hidden)`. What isn't hidden is kept exactly as it was */
function hideParams(text: string): string {
  return text
    .split("&")
    .map((part) => {
      const equals = part.indexOf("=");
      if (equals < 0) return part;
      const name = part.slice(0, equals);
      return isSecretName(decodeName(name)) ? `${name}=${HIDDEN}` : part;
    })
    .join("&");
}

/**
 * A URL with its credentials hidden: a password before the host, and parameters named like credentials, in the query and
 * in a fragment (`#access_token=…`). Works on the text, so the rest of the URL stays exactly as it was, relative or not
 */
export function safeUrl(url: string): string {
  const hashAt = url.indexOf("#");
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const base = (queryAt < 0 ? beforeHash : beforeHash.slice(0, queryAt)).replace(
    /^([a-z][a-z0-9+.-]*:\/\/[^/?#@]*?:)[^/?#@]*@/i,
    `$1${HIDDEN}@`,
  );
  const query = queryAt < 0 ? "" : `?${hideParams(beforeHash.slice(queryAt + 1))}`;
  const hash = hashAt < 0 ? "" : `#${hideParams(url.slice(hashAt + 1))}`;
  return base + query + hash;
}

/**
 * Headers as `[name, value]`, hiding credentials: page scripts can't read an HttpOnly cookie, so agents don't either.
 * Names are matched by pattern, as sites name their own (`X-Api-Key`, `X-Auth-Token`)
 */
export function safeHeaders(
  headers: { name: string; value?: string }[] | undefined,
): [string, string][] {
  return (headers ?? []).map(({ name, value }) => {
    const lower = name.toLowerCase();
    if (isSecretName(lower)) return [name, HIDDEN];
    return [name, URL_HEADERS.has(lower) ? safeUrl(value ?? "") : (value ?? "")];
  });
}

function hideJson(value: unknown, hid: { any: boolean }): unknown {
  if (Array.isArray(value)) return value.map((item) => hideJson(item, hid));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (!isSecretName(key)) return [key, hideJson(item, hid)];
      hid.any = true;
      return [key, HIDDEN];
    }),
  );
}

/** A body the page sent, with credentials hidden: in JSON, by key, and otherwise as `name=value` pairs */
function safeBodyText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const hid = { any: false };
      const hidden = hideJson(JSON.parse(trimmed), hid);
      // Kept exactly as sent when there's nothing to hide
      return hid.any ? JSON.stringify(hidden) : text;
    } catch {
      // Not JSON after all
    }
  }
  return hideParams(text);
}

/**
 * What a request sent, from `webRequest`'s `requestBody`, with credentials hidden. Fields are matched by name, so a
 * password in a field named `p1` would still show; the README says so
 */
export function safePostData(body: unknown, limit: number): string | undefined {
  const request = body as
    | { formData?: Record<string, string[]>; raw?: { bytes?: ArrayBuffer }[] }
    | undefined;
  if (!request) return undefined;
  if (request.formData) {
    return Object.entries(request.formData)
      .map(([key, values]) => `${key}=${isSecretName(key) ? HIDDEN : values.join(",")}`)
      .join("&");
  }
  const bytes = request.raw?.[0]?.bytes;
  if (!bytes) return undefined;
  return safeBodyText(new TextDecoder().decode(bytes.slice(0, limit)));
}

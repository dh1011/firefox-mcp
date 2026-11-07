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
  return !RESTRICTED_HOSTS.has(parsed.hostname);
}

export function refusedUrlMessage(url: string): string {
  return `Agents can't use ${url}: only web pages (http and https), not browser pages, extension pages, local files or Mozilla's add-on and account sites`;
}

const SECRET_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "set-cookie2",
  "x-csrf-token",
  "x-xsrf-token",
]);

/** Headers as `[name, value]`, hiding credentials: page scripts can't read an HttpOnly cookie, so agents don't either */
export function safeHeaders(
  headers: { name: string; value?: string }[] | undefined,
): [string, string][] {
  return (headers ?? []).map(({ name, value }) => [
    name,
    SECRET_HEADERS.has(name.toLowerCase()) ? "(hidden)" : (value ?? ""),
  ]);
}

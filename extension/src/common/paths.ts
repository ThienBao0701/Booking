/** Page-path handling: path only, never query string or fragment (they often carry tokens/PII). */

import { redactText } from "../shared.ts";

const MAX_PAGE_LEN = 512;

/** Extract a redacted path from a URL or path ("https://h/a/b?token=x#y" → "/a/b"). */
export function pagePath(urlOrPath: string | undefined): string {
  if (!urlOrPath) return "/";
  let path: string;
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(urlOrPath);
  if (m) path = m[1] ?? "";
  else path = urlOrPath.split(/[?#]/)[0] ?? "";
  if (path.length === 0) path = "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return redactText(path).slice(0, MAX_PAGE_LEN);
}

/** Origin part of a URL ("https://h:8443/x" → "https://h:8443"), or undefined. */
export function urlOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return m ? (m[1] as string).toLowerCase() : undefined;
}

/** Host only (no port, no userinfo), for session target metadata. */
export function urlHost(url: string | undefined): string | undefined {
  const o = urlOrigin(url);
  if (!o) return undefined;
  const authority = o.replace(/^https?:\/\//, "");
  if (authority.includes("@")) return undefined;
  return authority.startsWith("[") ? authority.slice(0, authority.indexOf("]") + 1) : authority.split(":")[0];
}

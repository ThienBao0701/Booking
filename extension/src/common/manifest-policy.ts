/**
 * Least-privilege policy for manifest.json (Component 13 / ADR-0002). Used by
 * the unit tests AND by build.mjs, so a manifest that widens privileges fails
 * both CI and the build.
 */

/**
 * The only API permissions the extension may request. `nativeMessaging`
 * (Phase 14, ADR-0009) lets the extension reach ONLY native hosts whose
 * manifest lists this extension's id in `allowed_origins`; the code may use it
 * only to connect to the lab host (lint + build enforce the host name).
 */
export const ALLOWED_PERMISSIONS = ["storage", "alarms", "scripting", "activeTab", "nativeMessaging"] as const;

/**
 * Permissions that are never acceptable here, each tied to an excluded
 * capability: request manipulation (Component 7 is observe-only), proxy (IP
 * rotation), debugger/CDP (fingerprint manipulation), cookies/privacy (auth
 * secrets), management (would widen reach).
 */
export const FORBIDDEN_PERMISSIONS = [
  "proxy",
  "debugger",
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess",
  "cookies",
  "privacy",
  "management",
  "contentSettings",
  "history",
  "tabs",
  "webNavigation",
] as const;

const LOOPBACK_PATTERNS = new Set(["http://127.0.0.1/*", "http://localhost/*", "http://[::1]/*"]);

function arr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function checkManifestPolicy(manifest: Record<string, unknown>): string[] {
  const violations: string[] = [];
  const json = JSON.stringify(manifest);

  if (manifest.manifest_version !== 3) violations.push("manifest_version must be 3");
  if (json.includes("<all_urls>")) violations.push("<all_urls> is not allowed anywhere");

  for (const p of arr(manifest.permissions)) {
    if ((FORBIDDEN_PERMISSIONS as readonly string[]).includes(p)) violations.push(`forbidden permission: ${p}`);
    else if (!(ALLOWED_PERMISSIONS as readonly string[]).includes(p)) violations.push(`unexpected permission: ${p}`);
  }

  for (const h of arr(manifest.host_permissions)) {
    if (!LOOPBACK_PATTERNS.has(h)) violations.push(`required host permission must be loopback, got: ${h}`);
  }

  const optional = arr(manifest.optional_host_permissions);
  for (const h of optional) {
    if (!/^https?:\/\/\*\/\*$/.test(h) && !/^https?:\/\/[^*]+\/\*$/.test(h)) {
      violations.push(`unexpected optional host permission: ${h}`);
    }
  }
  if (arr(manifest.optional_permissions).length > 0) violations.push("optional_permissions not allowed");

  const cs = Array.isArray(manifest.content_scripts) ? (manifest.content_scripts as Array<Record<string, unknown>>) : [];
  for (const c of cs) {
    for (const m of arr(c.matches)) {
      if (!LOOPBACK_PATTERNS.has(m)) violations.push(`static content script must match loopback only, got: ${m}`);
    }
    if (c.world === "MAIN") violations.push("content scripts must run in the ISOLATED world");
  }

  if (manifest.externally_connectable !== undefined) {
    violations.push("externally_connectable is not allowed (web pages must not message the extension)");
  }
  if (manifest.web_accessible_resources !== undefined) {
    violations.push("web_accessible_resources is not allowed (avoids page-visible extension resources)");
  }

  const bg = manifest.background as Record<string, unknown> | undefined;
  if (!bg || typeof bg.service_worker !== "string") violations.push("background.service_worker is required");

  const csp = manifest.content_security_policy as Record<string, unknown> | undefined;
  const pagesCsp = typeof csp?.extension_pages === "string" ? csp.extension_pages : "";
  if (/unsafe-eval|unsafe-inline|https?:/.test(pagesCsp)) {
    violations.push("extension_pages CSP must not allow eval, inline or remote scripts");
  }
  return violations;
}

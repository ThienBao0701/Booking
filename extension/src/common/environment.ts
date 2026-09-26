/**
 * Diagnostic environment facts (Component 8), read-only. They are recorded so
 * that sessions can be compared ("was the viewport different?"). Nothing here is
 * altered, randomized or spoofed, and no identifier beyond coarse browser /
 * platform / locale facts is collected (no full user-agent string, no fonts,
 * no canvas / audio / WebGL probing).
 */

export interface NavigatorLike {
  userAgent?: string;
  language?: string;
  platform?: string;
  hardwareConcurrency?: number;
  userAgentData?: { platform?: string; brands?: ReadonlyArray<{ brand: string; version: string }> };
}

const BROWSERS: ReadonlyArray<[string, RegExp]> = [
  ["Edge", /\bEdg\/(\d+)/],
  ["Opera", /\bOPR\/(\d+)/],
  ["Chrome", /\bChrome\/(\d+)/],
  ["Firefox", /\bFirefox\/(\d+)/],
];

/** Browser family + major version from the UA (the full UA string is not kept). */
export function browserFamily(ua: string | undefined): { browser?: string; browser_major?: number } {
  if (!ua) return {};
  for (const [name, re] of BROWSERS) {
    const m = re.exec(ua);
    if (m) return { browser: name, browser_major: Number(m[1]) };
  }
  return {};
}

/** Browser-level facts, attached to `session_start` as metadata.environment. */
export function browserEnvironment(
  nav: NavigatorLike,
  extensionVersion: string | undefined,
  now: Date = new Date(),
): Record<string, unknown> {
  const env: Record<string, unknown> = { ...browserFamily(nav.userAgent) };
  const platform = nav.userAgentData?.platform || nav.platform;
  if (platform) env.platform = platform;
  if (nav.language) env.language = nav.language;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) env.timezone = tz;
  } catch {
    /* Intl unavailable */
  }
  env.timezone_offset_min = -now.getTimezoneOffset();
  if (typeof nav.hardwareConcurrency === "number") env.hardware_concurrency = nav.hardwareConcurrency;
  if (extensionVersion) env.extension_version = extensionVersion;
  return env;
}

export interface WindowLike {
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio?: number;
  screen?: { width: number; height: number };
  matchMedia?: (q: string) => { matches: boolean };
}

/** Page-level facts, attached to the first `page_state` as metadata.environment. */
export function pageEnvironment(w: WindowLike): Record<string, unknown> {
  const env: Record<string, unknown> = { viewport: { width: w.innerWidth, height: w.innerHeight } };
  if (w.screen) env.screen = { width: w.screen.width, height: w.screen.height };
  if (typeof w.devicePixelRatio === "number") env.device_pixel_ratio = w.devicePixelRatio;
  if (w.matchMedia) env.color_scheme = w.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return env;
}

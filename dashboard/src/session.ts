/** Token storage for this browser tab (sessionStorage; ADR-0006). */

import { isPlausibleToken, takeToken } from "./token.ts";

const TOKEN_KEY = "lab.dashboard.token";

function storage(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

export function storeToken(token: string): void {
  try {
    storage()?.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode: the token lives in memory only */
  }
}

/** Take a token from the URL fragment (then scrub it) or from this tab's storage. */
export function readToken(): string | undefined {
  const { token, rest } = takeToken(location.hash);
  if (token || rest !== location.hash) history.replaceState(null, "", `${location.pathname}${rest}`);
  if (token) {
    storeToken(token);
    return token;
  }
  try {
    const t = storage()?.getItem(TOKEN_KEY) ?? undefined;
    return t && isPlausibleToken(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

export function signOut(): void {
  try {
    storage()?.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  location.hash = "#/overview";
  location.reload();
}

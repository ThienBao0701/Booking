/** Theme preference (system / light / dark), a per-viewer convenience in localStorage. */

const KEY = "lab.dashboard.theme";
export type Theme = "system" | "light" | "dark";

export function getTheme(): Theme {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function setTheme(t: Theme): void {
  try {
    if (t === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, t);
  } catch {
    /* storage unavailable: applies to this page view only */
  }
  applyTheme(t);
}

export function applyTheme(t: Theme = getTheme()): void {
  if (t === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}

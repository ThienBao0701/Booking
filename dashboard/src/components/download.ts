/** Hand bytes fetched with the token to the browser as a file download. */

import { h } from "../dom.ts";

export function saveBlob(bytes: ArrayBuffer, type: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = h("a", { class: "sr-only", download: filename }) as HTMLAnchorElement;
  a.href = url; // blob: URL created here (not recorded data)
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

import type { DesktopPreviewAutofillMenuResult } from "@t3tools/contracts";

import { previewBridge } from "./previewBridge";

/** The desktop bridge exposes the method only on macOS. */
export const previewAutofillAvailable = typeof previewBridge?.openAutofillMenu === "function";

export async function openPreviewAutofillMenu(
  runtimeTabId: string,
): Promise<DesktopPreviewAutofillMenuResult> {
  const open = previewBridge?.openAutofillMenu;
  const webview = document.querySelector<HTMLElementTagNameMap["webview"]>(
    `webview[data-preview-tab="${CSS.escape(runtimeTabId)}"]`,
  );
  if (!open || !webview) return "unavailable";
  let webContentsId: number;
  try {
    webContentsId = webview.getWebContentsId();
  } catch {
    return "unavailable";
  }
  const { x, y, width, height } = webview.getBoundingClientRect();
  return open({ webContentsId, webviewRect: { x, y, width, height } });
}

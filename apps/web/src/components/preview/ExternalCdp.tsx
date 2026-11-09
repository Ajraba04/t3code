import type { DesktopPreviewExternalCdpState } from "@t3tools/contracts";
import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

export const externalCdpBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.preview?.externalCdp ?? null);

/** The desktop's local CDP endpoint, or null outside the desktop app. */
export function useExternalCdpState(): DesktopPreviewExternalCdpState | null {
  const [state, setState] = useState<DesktopPreviewExternalCdpState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop's CDP endpoint state over IPC
  useEffect(() => {
    if (!externalCdpBridge) return;
    let live = true;
    const unsubscribe = externalCdpBridge.onStateChange(setState);
    void externalCdpBridge.getState().then(
      (current) => {
        if (live) setState(current);
      },
      () => undefined,
    );
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}

export function copyExternalCdp(value: "endpoint" | "token"): void {
  void externalCdpBridge?.copy(value).then(
    () =>
      toastManager.add({
        type: "success",
        title: value === "token" ? "CDP token copied" : "CDP endpoint copied",
        description:
          value === "token"
            ? "Send it as an Authorization: Bearer header. It changes when T3 Code restarts."
            : "Your CDP client also needs the token.",
      }),
    () => toastManager.add({ type: "error", title: "Couldn't copy" }),
  );
}

/** Shows while an outside CDP client drives the tab, with the way to cut it off. */
export function ExternalCdpIndicator({ tabId }: { readonly tabId: string }) {
  const state = useExternalCdpState();
  if (!externalCdpBridge || !state?.attachedTabIds.includes(tabId)) return null;
  return (
    <span className="flex shrink-0 items-center">
      <Tooltip>
        <TooltipTrigger render={<Badge variant="warning" />}>Debugger attached</TooltipTrigger>
        <TooltipPopup side="top">An outside CDP client is connected to this tab.</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label="Disconnect debugger"
              onClick={() => void externalCdpBridge?.disconnect(tabId).catch(() => undefined)}
            />
          }
        >
          <X />
        </TooltipTrigger>
        <TooltipPopup side="top">Disconnect</TooltipPopup>
      </Tooltip>
    </span>
  );
}

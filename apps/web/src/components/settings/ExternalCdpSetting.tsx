import { useState } from "react";

import { copyExternalCdp, externalCdpBridge, useExternalCdpState } from "../preview/ExternalCdp";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

// Session-only: the port and token change every run, so outside clients are set up again anyway.
export function ExternalCdpSetting() {
  const state = useExternalCdpState();
  const [isUpdating, setIsUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!externalCdpBridge) return null;
  const enabled = state?.enabled ?? false;

  const setEnabled = async (next: boolean) => {
    setIsUpdating(true);
    setError(null);
    try {
      await externalCdpBridge?.setEnabled(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't change this setting.");
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <SettingsRow
      {...searchableSetting("external-cdp")}
      description={
        enabled
          ? "CDP clients on this computer, such as Chrome DevTools MCP or Playwright, can drive browser tabs with the token. Any program running as you can also use it. Turns off when T3 Code restarts."
          : "Let CDP clients on this computer, such as Chrome DevTools MCP or Playwright, drive browser tabs alongside agents. Turns off when T3 Code restarts."
      }
      status={
        error ? (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        ) : enabled && state?.endpoint ? (
          <span className="break-all font-mono">{state.endpoint}</span>
        ) : undefined
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          {enabled ? (
            <>
              <Button size="compact" variant="outline" onClick={() => copyExternalCdp("endpoint")}>
                Copy endpoint
              </Button>
              <Button size="compact" variant="outline" onClick={() => copyExternalCdp("token")}>
                Copy token
              </Button>
            </>
          ) : null}
          <Switch
            checked={enabled}
            disabled={isUpdating || state === null}
            onCheckedChange={(next) => void setEnabled(next)}
            aria-label="Outside CDP tools"
          />
        </div>
      }
    />
  );
}

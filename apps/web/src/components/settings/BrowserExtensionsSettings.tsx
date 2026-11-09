import {
  type BrowserExtension,
  DEFAULT_BROWSER_PROFILE_ID,
  findBrowserProfile,
  managedCapabilityDenial,
  resolveBrowserProfiles,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { usePrimaryManagedPolicy } from "~/state/managedPolicy";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection, SettingsUnavailableGroup } from "./settingsLayout";

/** IPC prefixes the desktop's message with the channel and error name; keep the sentence. */
const browserExtensionErrorMessage = (cause: unknown): string => {
  const message = String((cause as { message?: unknown } | undefined)?.message ?? cause);
  return message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/u, "");
};

type Listing = {
  readonly profileId: string;
  readonly extensions: ReadonlyArray<BrowserExtension>;
};

export function BrowserExtensionsSection({
  desktopOnlyMessage,
}: {
  readonly desktopOnlyMessage: string | undefined;
}) {
  // Extensions load in this desktop's browser, whose policy the primary environment reports.
  const denial = managedCapabilityDenial(usePrimaryManagedPolicy(), "browserExtensions");
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const profiles = resolveBrowserProfiles(userProfiles).filter(
    (profile) => profile.kind === "persistent",
  );
  const [chosenProfileId, setChosenProfileId] = useState<string | null>(null);
  const profile =
    findBrowserProfile(profiles, chosenProfileId ?? defaultProfileId) ??
    findBrowserProfile(profiles, DEFAULT_BROWSER_PROFILE_ID)!;
  const [listing, setListing] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const available = previewBridge !== null && desktopOnlyMessage === undefined;
  const loadEnabled = available && denial === undefined;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the selected profile's extensions from the desktop app, which owns them
  useEffect(() => {
    if (!loadEnabled || previewBridge === null) return;
    let current = true;
    previewBridge.listBrowserExtensions(profile.id).then(
      (extensions) => {
        if (current) setListing({ profileId: profile.id, extensions });
      },
      (cause: unknown) => {
        if (!current) return;
        toastManager.add({
          type: "error",
          title: "Could not read browser extensions",
          description: browserExtensionErrorMessage(cause),
        });
      },
    );
    return () => {
      current = false;
    };
  }, [loadEnabled, profile.id]);

  if (denial !== undefined) return null;

  const extensions = listing?.profileId === profile.id ? listing.extensions : [];
  const run = (
    title: string,
    action: (bridge: NonNullable<typeof previewBridge>) => Promise<ReadonlyArray<BrowserExtension>>,
  ) => {
    if (previewBridge === null || busy) return;
    const profileId = profile.id;
    setBusy(true);
    action(previewBridge)
      .then(
        (next) => setListing({ profileId, extensions: next }),
        (cause: unknown) =>
          toastManager.add({
            type: "error",
            title,
            description: browserExtensionErrorMessage(cause),
          }),
      )
      .finally(() => setBusy(false));
  };

  return (
    <SettingsSection id="browser-extensions" title="Extensions">
      <SettingsUnavailableGroup message={desktopOnlyMessage}>
        <SettingsRow
          title="Unpacked extensions"
          description="Load an extension folder into a browser profile. It runs in every tab of that profile, including tabs agents open."
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto">
              <Select
                disabled={!available}
                value={profile.id}
                onValueChange={(value) => {
                  if (typeof value === "string") setChosenProfileId(value);
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Browser profile">
                  <SelectValue>{profile.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {profiles.map((candidate) => (
                    <SelectItem hideIndicator key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="sm"
                variant="outline"
                disabled={!available || busy}
                onClick={() =>
                  run("Could not add the extension", (bridge) =>
                    bridge.addBrowserExtension(profile.id),
                  )
                }
              >
                <PlusIcon />
                Add folder
              </Button>
            </div>
          }
        >
          {extensions.length === 0 ? null : (
            <div className="mt-2 mb-2 overflow-hidden rounded-lg border border-border/60">
              {extensions.map((extension, index) => (
                <div
                  key={extension.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2",
                    index > 0 && "border-t border-border/60",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-foreground">
                      {extension.name ?? extension.path}
                      {extension.version === null ? null : (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {extension.version}
                        </span>
                      )}
                    </p>
                    <p
                      className={cn(
                        "truncate text-xs",
                        extension.error === null
                          ? "text-muted-foreground"
                          : "text-destructive-foreground",
                      )}
                    >
                      {extension.error ?? extension.path}
                    </p>
                  </div>
                  <Switch
                    checked={extension.enabled}
                    disabled={!available || busy}
                    aria-label={`Enable ${extension.name ?? extension.path}`}
                    onCheckedChange={(checked) =>
                      run("Could not change the extension", (bridge) =>
                        bridge.setBrowserExtensionEnabled(
                          profile.id,
                          extension.id,
                          Boolean(checked),
                        ),
                      )
                    }
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    disabled={!available || busy}
                    aria-label={`Remove ${extension.name ?? extension.path}`}
                    onClick={() =>
                      run("Could not remove the extension", (bridge) =>
                        bridge.removeBrowserExtension(profile.id, extension.id),
                      )
                    }
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </SettingsRow>
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}

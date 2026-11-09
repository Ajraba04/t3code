import type {
  DesktopPreviewAutofillMenuResult,
  DesktopPreviewOpenAutofillMenuInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import {
  COLLECT_LOGIN_FIELDS_SCRIPT,
  FocusedLoginField,
  focusLoginFieldScript,
  guestFieldToWindowPoint,
  LoginFieldCandidate,
  selectLoginField,
} from "./AutofillField.ts";
import { guestEditMenuItems } from "./GuestContextMenu.ts";

const AUTOFILL_WORLD_ID = 1003;

const decodeCandidates = Schema.decodeUnknownOption(Schema.Array(LoginFieldCandidate));
const decodeField = Schema.decodeUnknownOption(FocusedLoginField);

const runInGuest = <A>(
  guest: Electron.WebContents,
  code: string,
  decode: (value: unknown) => Option.Option<A>,
) =>
  Effect.tryPromise(() =>
    guest.executeJavaScriptInIsolatedWorld(AUTOFILL_WORLD_ID, [{ code }], true),
  ).pipe(
    Effect.timeoutOption("2 seconds"),
    Effect.map((value) => Option.flatMap(value, decode)),
    Effect.orElseSucceed(() => Option.none<A>()),
  );

/**
 * macOS adds AutoFill > Passwords… to a menu popped with the guest's frame (Electron 36+).
 * Whether a programmatic popup gets it, or only a real right-click, needs a device check.
 */
export const openAutofillMenu = Effect.fn("PreviewAutofillMenu.open")(function* (
  input: DesktopPreviewOpenAutofillMenuInput,
  senderId: number | undefined,
) {
  const unavailable: DesktopPreviewAutofillMenuResult = "unavailable";
  if ((yield* HostProcess.Platform) !== "darwin") return unavailable;
  const guest = Electron.webContents.fromId(input.webContentsId);
  const host = guest?.hostWebContents;
  // Only the renderer hosting this webview may drive it.
  if (!guest || guest.isDestroyed() || guest.getType() !== "webview") return unavailable;
  if (!host || senderId === undefined || host.id !== senderId) return unavailable;
  const window = Electron.BrowserWindow.fromWebContents(host);
  if (!window || window.isDestroyed()) return unavailable;

  const candidates = yield* runInGuest(guest, COLLECT_LOGIN_FIELDS_SCRIPT, decodeCandidates);
  if (Option.isNone(candidates)) return unavailable;
  const index = selectLoginField(candidates.value);
  if (index === null) return "no-field" as const;

  // Native edit roles act on the focused webContents.
  guest.focus();
  const field = yield* runInGuest(guest, focusLoginFieldScript(index), decodeField);
  if (Option.isNone(field)) return "no-field" as const;
  const point = guestFieldToWindowPoint({
    webviewRect: input.webviewRect,
    hostZoomFactor: host.getZoomFactor(),
    field: field.value,
  });
  if (!point || guest.isDestroyed() || window.isDestroyed()) return unavailable;

  return yield* Effect.try(() => {
    Electron.Menu.buildFromTemplate(
      guestEditMenuItems({
        canCut: field.value.canCopy,
        canCopy: field.value.canCopy,
        canPaste: true,
        canSelectAll: field.value.hasValue,
      }),
    ).popup({ window, frame: guest.mainFrame, x: point.x, y: point.y });
    return "opened" as const;
  }).pipe(Effect.orElseSucceed(() => unavailable));
});

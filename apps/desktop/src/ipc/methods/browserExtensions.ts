import {
  BrowserExtensionSchema,
  DesktopBrowserExtensionInputSchema,
  DesktopBrowserExtensionSetEnabledInputSchema,
  DesktopBrowserExtensionsInputSchema,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as BrowserExtensions from "../../preview/Extensions.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const ExtensionList = Schema.Array(BrowserExtensionSchema);

export const listBrowserExtensions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_LIST_CHANNEL,
  payload: DesktopBrowserExtensionsInputSchema,
  result: ExtensionList,
  handler: Effect.fn("desktop.ipc.browserExtensions.list")(function* ({ profileId }) {
    const extensions = yield* BrowserExtensions.BrowserExtensions;
    return yield* extensions.list(profileId);
  }),
});

/** The folder comes from the native picker here; the renderer only names the profile. */
export const addBrowserExtension = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_ADD_CHANNEL,
  payload: DesktopBrowserExtensionsInputSchema,
  result: ExtensionList,
  handler: Effect.fn("desktop.ipc.browserExtensions.add")(function* ({ profileId }) {
    const extensions = yield* BrowserExtensions.BrowserExtensions;
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    // Refuse before the picker opens, so a managed machine never shows it.
    yield* extensions.checkPolicy;
    const directory = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: Option.none(),
    });
    return Option.isNone(directory)
      ? yield* extensions.list(profileId)
      : yield* extensions.addFolder(profileId, directory.value);
  }),
});

export const setBrowserExtensionEnabled = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_SET_ENABLED_CHANNEL,
  payload: DesktopBrowserExtensionSetEnabledInputSchema,
  result: ExtensionList,
  handler: Effect.fn("desktop.ipc.browserExtensions.setEnabled")(function* ({
    profileId,
    extensionId,
    enabled,
  }) {
    const extensions = yield* BrowserExtensions.BrowserExtensions;
    return yield* extensions.setEnabled(profileId, extensionId, enabled);
  }),
});

export const removeBrowserExtension = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.PREVIEW_EXTENSIONS_REMOVE_CHANNEL,
  payload: DesktopBrowserExtensionInputSchema,
  result: ExtensionList,
  handler: Effect.fn("desktop.ipc.browserExtensions.remove")(function* ({
    profileId,
    extensionId,
  }) {
    const extensions = yield* BrowserExtensions.BrowserExtensions;
    return yield* extensions.remove(profileId, extensionId);
  }),
});

import type * as Electron from "electron";

export const guestEditMenuItems = (
  editFlags: Pick<Electron.EditFlags, "canCut" | "canCopy" | "canPaste" | "canSelectAll">,
): Electron.MenuItemConstructorOptions[] => [
  { role: "cut", enabled: editFlags.canCut },
  { role: "copy", enabled: editFlags.canCopy },
  { role: "paste", enabled: editFlags.canPaste },
  { role: "selectAll", enabled: editFlags.canSelectAll },
];

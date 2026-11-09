import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
import "~/index.css";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { render } from "../../test/render";

const pickerState = vi.hoisted(() => ({ sameHome: false, openEditor: vi.fn() }));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const editors = Atom.make(["vscode"] as const);
  return { ...actual, serverAvailableEditorsAtom: () => editors };
});
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const actual = await original();
  const { shellEnvironment } = await import("~/state/shell");
  return {
    ...actual,
    useAtomCommand: ((command, options) => {
      const run = actual.useAtomCommand(command, options);
      return Object.is(command, shellEnvironment.openInEditor) ? pickerState.openEditor : run;
    }) as typeof actual.useAtomCommand,
  };
});
vi.mock(import("~/state/environments"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    usePrimaryEnvironment: () => {
      const primary = actual.usePrimaryEnvironment();
      return pickerState.sameHome && primary !== null
        ? { ...primary, environmentId: EnvironmentId.make("wsl-primary") }
        : primary;
    },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useRemoteOpenResolution: (environmentId) => {
      const resolution = actual.useRemoteOpenResolution(environmentId);
      return pickerState.sameHome
        ? { state: { mode: "local-exec" as const }, isResolved: true, isSameHomeBearer: true }
        : resolution;
    },
  };
});

// The transport uses deterministic server fixtures.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("opens the selected same-home workspace by shortcut with another primary", async () => {
  await page.viewport(1400, 900);
  pickerState.sameHome = true;
  pickerState.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  using _reset = {
    [Symbol.dispose]() {
      pickerState.sameHome = false;
    },
  };
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-secondary-home");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-secondary-home"),
    });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  const toggle = page.getByRole("button", { name: "Toggle thread details panel", exact: true });
  if (toggle.element().getAttribute("aria-pressed") === "false") await toggle.click();
  await expect.element(page.getByRole("group", { name: "Open in editor" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Open in VS Code", exact: true }))
    .toBeEnabled();
  await userEvent.keyboard("{Control>}o{/Control}");
  await vi.waitFor(() =>
    expect(pickerState.openEditor).toHaveBeenCalledExactlyOnceWith({
      environmentId: ENVIRONMENT_ID,
      input: { cwd: "/workspace/render", editor: "vscode" },
    }),
  );
  await toggle.click();
  await expect.element(page.getByRole("group", { name: "Open in editor" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Control>}o{/Control}");
  await vi.waitFor(() => expect(pickerState.openEditor).toHaveBeenCalledTimes(2));
  expect(pickerState.openEditor).toHaveBeenLastCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { cwd: "/workspace/render", editor: "vscode" },
  });
});

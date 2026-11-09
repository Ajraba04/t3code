import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  PreviewCaptureFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as PreviewManager from "../../preview/Manager.ts";
import * as SessionCookieSnapshot from "../../preview/SessionCookieSnapshot.ts";
import * as PreviewIpc from "./preview.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as DesktopClientSettings from "../../settings/DesktopClientSettings.ts";

const { fromPartition } = vi.hoisted(() => ({
  fromPartition: vi.fn(() => {
    throw new Error("Session can only be received when app is ready");
  }),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  session: {
    fromPartition,
  },
  webContents: {
    fromId: vi.fn(() => null),
  },
}));

const decodeCaptureFailure = Schema.decodeUnknownEffect(PreviewCaptureFailure);

describe("preview IPC methods", () => {
  const invokeCapture = (
    method: typeof PreviewIpc.startRecording | typeof PreviewIpc.captureScreenshot,
    manager: Partial<PreviewManager.PreviewManager["Service"]>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make({
          removeHandler: vi.fn(),
          handle: (_channel, registered) => {
            listener = registered;
          },
          removeAllListeners: vi.fn(),
          on: vi.fn(),
        });
        yield* ipc.handle(method);
        return yield* Effect.promise(async () =>
          structuredClone(await listener!({ sender: { id: 7 } }, { tabId: "capture-tab" })),
        );
      }).pipe(
        Effect.provideService(
          PreviewManager.PreviewManager,
          manager as PreviewManager.PreviewManager["Service"],
        ),
        Effect.provideService(DesktopClientSettings.DesktopClientSettings, {
          get: Effect.succeedNone,
          set: () => Effect.void,
        }),
      ),
    );

  effectIt.effect.each([
    {
      cause: new Error("Current display surface not available for capture"),
      reason: "capture-unavailable",
      guidance: ["target tab", "unlocked", "display is on", "window is restored"],
    },
    {
      cause: new Cause.TimeoutError(),
      reason: "capture-timeout",
      guidance: ["timed out during capture-page"],
    },
    {
      cause: new Error("Current display surface not available for capture: private page data"),
      reason: "capture-failed",
      guidance: ["Preview capture failed during capture-page"],
    },
  ])(
    "transports a safe $reason screenshot diagnostic through registered IPC",
    ({ cause, reason, guidance }) =>
      Effect.gen(function* () {
        const result = yield* invokeCapture(PreviewIpc.captureScreenshot, {
          captureScreenshot: (tabId) =>
            Effect.fail(
              new PreviewManager.PreviewOperationError({
                operation: "captureScreenshot.capturePage",
                tabId,
                artifactPath: "/private/capture.png",
                cause,
              }),
            ),
        });
        expect(result).toEqual({
          _tag: "PreviewCaptureFailure",
          reason,
          stage: "capture-page",
        });
        const failure = yield* decodeCaptureFailure(result);
        for (const phrase of guidance) expect(failure.message).toContain(phrase);
      }),
  );

  beforeEach(() => {
    fromPartition.mockClear();
  });

  effectIt.effect("hands out a guest's partition only after its session cookies are restored", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browserSession = {} as Electron.Session;
        const restored = yield* SessionCookieSnapshot.markRestoring(browserSession);
        const restoredWhenPartitionRead: Array<boolean> = [];
        const getBrowserPartition = () =>
          Deferred.isDone(restored).pipe(
            Effect.map((done) => {
              restoredWhenPartitionRead.push(done);
              return "persist:t3code-preview-test";
            }),
          );
        let listener: DesktopIpc.DesktopIpcHandleListener | undefined;
        const ipc = DesktopIpc.make({
          removeHandler: vi.fn(),
          handle: (_channel, registered) => {
            listener = registered;
          },
          removeAllListeners: vi.fn(),
          on: vi.fn(),
        });
        yield* ipc.handle(PreviewIpc.getPreviewConfig).pipe(
          Effect.provideService(PreviewManager.PreviewManager, {
            // The restore finishes on a later scheduler turn, after a handler that did not wait has read on.
            getBrowserSession: () =>
              Deferred.succeed(restored, undefined).pipe(
                Effect.forkDetach,
                Effect.as(browserSession),
              ),
            getBrowserPartition,
          } as unknown as PreviewManager.PreviewManager["Service"]),
        );

        const config = yield* Effect.promise(async () =>
          structuredClone(await listener!({ sender: { id: 7 } }, { environmentId: "env-a" })),
        );
        expect(config).toMatchObject({
          partition: "persist:t3code-preview-test",
        });
        expect(restoredWhenPartitionRead).toEqual([true]);
      }),
    ),
  );

  it("derives distinct partition scopes when identifiers contain the delimiter", () => {
    const first = PreviewIpc.resolvePartitionScope("a", "b::c");
    const second = PreviewIpc.resolvePartitionScope("a::b", "c");

    expect(first).toEqual({ scope: '["a","b::c"]', persistent: true, namespace: "profile" });
    expect(second).toEqual({ scope: '["a::b","c"]', persistent: true, namespace: "profile" });
    expect(first.scope).not.toBe(second.scope);
  });

  it("keeps the legacy default partition scope and incognito persistence", () => {
    expect(PreviewIpc.resolvePartitionScope("environment::legacy", undefined)).toEqual({
      scope: "environment::legacy",
      persistent: true,
    });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", DEFAULT_BROWSER_PROFILE_ID),
    ).toEqual({ scope: "environment::legacy", persistent: true });
    expect(
      PreviewIpc.resolvePartitionScope("environment::legacy", INCOGNITO_BROWSER_PROFILE_ID),
    ).toEqual({
      scope: '["environment::legacy","incognito"]',
      persistent: false,
      namespace: "profile",
    });
  });
});

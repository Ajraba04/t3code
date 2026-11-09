import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { ManagedPolicyDocument } from "@t3tools/contracts";
import { ManagedPolicyFileError } from "@t3tools/shared/managedPolicyFile";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

const { fromPartition } = vi.hoisted(() => ({ fromPartition: vi.fn() }));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
  session: { fromPartition },
  webContents: { fromId: vi.fn(() => null) },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { resolvePartitionScope } from "../ipc/methods/preview.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as BrowserExtensions from "./Extensions.ts";

const fakeSession = (persistent = true) => {
  const loadExtension = vi.fn(async (path: string) => ({ id: `electron:${path}` }));
  const removeExtension = vi.fn<(id: string) => void>();
  const session = {
    isPersistent: () => persistent,
    extensions: { loadExtension, removeExtension },
  } as unknown as BrowserExtensions.ExtensionSession;
  return { session, loadExtension, removeExtension };
};

/** A temp state dir with extension folders `a`, `b`, `c`; `service()` builds a fresh instance on it. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-ext-service-" });
  const folders: Record<string, string> = {};
  for (const name of ["a", "b", "c"]) {
    folders[name] = path.join(dir, "extensions", name);
    yield* fs.makeDirectory(folders[name], { recursive: true });
    yield* fs.writeFileString(
      path.join(folders[name], "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: `Ext ${name}`, version: "1.0" }),
    );
  }
  const service = (policy?: ManagedPolicyDocument | ManagedPolicyFileError) =>
    BrowserExtensions.make.pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        stateDir: dir,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
      Effect.provide(DesktopManagedPolicy.layerTest(policy)),
    );
  return { dir, folders, service };
});

const policy = (limits: NonNullable<ManagedPolicyDocument["limits"]>): ManagedPolicyDocument => ({
  schemaVersion: 1,
  organization: "Example Corp",
  limits,
});

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

describe("BrowserExtensions", () => {
  it.effect("adds, toggles and removes per profile, and keeps them across restarts", () =>
    Effect.gen(function* () {
      const { folders, service } = yield* setup;
      const extensions = yield* service();

      const added = yield* extensions.addFolder("default", folders.a!);
      assert.deepStrictEqual(
        added.map(({ name, version, enabled, error }) => ({ name, version, enabled, error })),
        [{ name: "Ext a", version: "1.0", enabled: true, error: null }],
      );
      const [first] = added;
      yield* extensions.addFolder("profile-work", folders.b!);
      yield* extensions.setEnabled("default", first!.id, false);

      const restarted = yield* service();
      assert.deepStrictEqual(
        (yield* restarted.list("default")).map(({ path, enabled }) => ({ path, enabled })),
        [{ path: folders.a, enabled: false }],
      );
      assert.lengthOf(yield* restarted.list("profile-work"), 1);

      assert.deepStrictEqual(yield* restarted.remove("default", first!.id), []);
      assert.deepStrictEqual(yield* (yield* service()).list("default"), []);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("refuses a folder that is not an extension, a duplicate, and Incognito", () =>
    Effect.gen(function* () {
      const { dir, folders, service } = yield* setup;
      const extensions = yield* service();
      const reason = (profileId: string, directory: string) =>
        extensions.addFolder(profileId, directory).pipe(
          Effect.match({
            onFailure: (error) =>
              error._tag === "BrowserExtensionRequestError" ? error.reason : error._tag,
            onSuccess: () => "ok",
          }),
        );

      assert.strictEqual(yield* reason("default", dir), "invalidManifest");
      assert.strictEqual(yield* reason("default", folders.a!), "ok");
      assert.strictEqual(yield* reason("default", folders.a!), "duplicate");
      assert.strictEqual(yield* reason("incognito", folders.b!), "ephemeralProfile");
      assert.strictEqual(
        yield* extensions.setEnabled("default", "nope", true).pipe(
          Effect.match({
            onFailure: (error) =>
              error._tag === "BrowserExtensionRequestError" ? error.reason : error._tag,
            onSuccess: () => "ok",
          }),
        ),
        "unknownExtension",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "loads a profile's enabled extensions into its persistent sessions and follows changes",
    () =>
      Effect.gen(function* () {
        const { folders, service } = yield* setup;
        const extensions = yield* service();
        const [a] = yield* extensions.addFolder("default", folders.a!);
        const added = yield* extensions.addFolder("default", folders.b!);
        const b = added[1]!;
        yield* extensions.setEnabled("default", b.id, false);
        yield* extensions.addFolder("profile-work", folders.c!);

        const main = fakeSession();
        const ephemeral = fakeSession(false);
        yield* extensions.attach(main.session, "default");
        yield* extensions.attach(main.session, "default");
        yield* extensions.attach(ephemeral.session, "incognito");
        assert.deepStrictEqual(main.loadExtension.mock.calls, [
          [folders.a, { allowFileAccess: false }],
        ]);
        assert.strictEqual(ephemeral.loadExtension.mock.calls.length, 0);

        yield* extensions.setEnabled("default", b.id, true);
        yield* extensions.setEnabled("default", a!.id, false);
        assert.deepStrictEqual(
          main.loadExtension.mock.calls.map(([path]) => path),
          [folders.a, folders.b],
        );
        assert.deepStrictEqual(main.removeExtension.mock.calls, [[`electron:${folders.a}`]]);

        yield* extensions.remove("default", b.id);
        assert.deepStrictEqual(main.removeExtension.mock.calls.at(-1), [`electron:${folders.b}`]);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("shows Electron's load error on the extension and still opens the session", () =>
    Effect.gen(function* () {
      const { folders, service } = yield* setup;
      const extensions = yield* service();
      yield* extensions.addFolder("default", folders.a!);
      const broken = fakeSession();
      broken.loadExtension.mockRejectedValueOnce(new Error("Manifest key 'background' bad"));

      yield* extensions.attach(broken.session, "default");
      const [entry] = yield* extensions.list("default");
      assert.strictEqual(entry!.error, "Manifest key 'background' bad");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "loads nothing and refuses changes when policy turns extensions off or is unreadable",
    () =>
      Effect.gen(function* () {
        const { folders, service } = yield* setup;
        yield* (yield* service()).addFolder("default", folders.a!);

        for (const denied of [
          policy({ browserExtensions: false }),
          new ManagedPolicyFileError({ path: "/test/policy.json", reason: "bad json" }),
        ]) {
          const extensions = yield* service(denied);
          const session = fakeSession();
          yield* extensions.attach(session.session, "default");
          assert.strictEqual(session.loadExtension.mock.calls.length, 0);
          const error = yield* Effect.flip(extensions.addFolder("default", folders.b!));
          assert.strictEqual(error._tag, "BrowserExtensionsPolicyError");
        }

        const allowed = yield* service(policy({ browserExtensions: true }));
        const session = fakeSession();
        yield* allowed.attach(session.session, "default");
        assert.strictEqual(session.loadExtension.mock.calls.length, 1);
      }).pipe(Effect.provide(layerTest)),
  );
});

describe("BrowserSession extension hook", () => {
  it.effect("attaches extensions only to persistent profile partitions", () =>
    Effect.gen(function* () {
      fromPartition.mockReset();
      fromPartition.mockImplementation((partition: string) => ({
        partition,
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn() },
      }));
      const attach = vi.fn<(session: unknown, profileId: string) => void>();
      const layer = BrowserSession.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            layerTest,
            Layer.succeed(ElectronDialog.ElectronDialog, {
              pickFolder: () => Effect.die("unused"),
              pickFiles: () => Effect.die("unused"),
              showMessageBox: () => Effect.die("unused"),
              showErrorBox: () => Effect.void,
            }),
            Layer.succeed(
              BrowserExtensions.BrowserExtensions,
              BrowserExtensions.BrowserExtensions.of({
                attach: (session, profileId) => Effect.sync(() => attach(session, profileId)),
              } as BrowserExtensions.BrowserExtensions["Service"]),
            ),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const sessions = yield* BrowserSession.BrowserSession;
        for (const profileId of [undefined, "default", "profile-work", "incognito"]) {
          const { scope, persistent, namespace } = resolvePartitionScope("env-1", profileId);
          yield* sessions.getSession(scope, persistent, namespace);
        }
        yield* sessions.getSession();
      }).pipe(Effect.provide(layer));

      assert.deepStrictEqual(
        attach.mock.calls.map(([, profileId]) => profileId),
        ["default", "default", "profile-work"],
      );
    }),
  );
});

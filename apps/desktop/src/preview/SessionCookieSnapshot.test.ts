import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as SessionCookieSnapshot from "./SessionCookieSnapshot.ts";

/** Fakes the two CDP commands the snapshot uses against an in-memory jar. */
const makeChannel = (initial: ReadonlyArray<SessionCookieSnapshot.CdpCookie> = []) => {
  const written: Array<object> = [];
  return {
    written,
    channel: {
      send: (method: string, params?: object) => {
        if (method === "Network.getAllCookies") return Promise.resolve({ cookies: initial });
        if (method === "Network.setCookie" && params !== undefined) written.push(params);
        return Promise.resolve({});
      },
    } satisfies SessionCookieSnapshot.CookieChannel,
  };
};

const reversed = (value: string) => [...value].reverse().join("");

const layerSafeStorage = (options: {
  readonly available?: boolean;
  readonly backend?: string;
  readonly encryptFails?: boolean;
}) =>
  Layer.succeed(
    ElectronSafeStorage.ElectronSafeStorage,
    ElectronSafeStorage.ElectronSafeStorage.of({
      isEncryptionAvailable: Effect.succeed(options.available ?? true),
      encryptString: (value) =>
        options.encryptFails
          ? Effect.fail(
              new ElectronSafeStorage.ElectronSafeStorageEncryptError({ cause: "locked" }),
            )
          : Effect.succeed(new TextEncoder().encode(reversed(value))),
      decryptString: (value) => Effect.succeed(reversed(new TextDecoder().decode(value))),
      selectedStorageBackend: Effect.succeed(Option.fromNullishOr(options.backend)),
    }),
  );

const withStorage = <A, E>(
  body: (
    storagePath: string,
  ) => Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ElectronSafeStorage.ElectronSafeStorage
  >,
  options: Parameters<typeof layerSafeStorage>[0] = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const storagePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-cookies-" });
      return yield* body(storagePath);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeServices.layer, layerSafeStorage(options))));

const cdpFields = { size: 1, priority: "Medium", sameParty: false, expires: -1 };
const hostOnly: SessionCookieSnapshot.CdpCookie = {
  ...cdpFields,
  name: "sid",
  value: "php-session",
  domain: "app.test",
  path: "/account",
  secure: false,
  httpOnly: true,
  session: true,
  sameSite: "Lax",
  sourceScheme: "NonSecure",
  sourcePort: 8080,
};
const hostPrefixed: SessionCookieSnapshot.CdpCookie = {
  ...cdpFields,
  name: "__Host-auth",
  value: "host-token",
  domain: "secure.test",
  path: "/",
  secure: true,
  httpOnly: true,
  session: true,
  sameSite: "Strict",
  sourceScheme: "Secure",
  sourcePort: 443,
};
const domainWide: SessionCookieSnapshot.CdpCookie = {
  ...cdpFields,
  name: "sso",
  value: "sso-token",
  domain: ".example.test",
  path: "/",
  secure: true,
  httpOnly: false,
  session: true,
  sameSite: "None",
};
const partitioned: SessionCookieSnapshot.CdpCookie = {
  ...hostPrefixed,
  name: "__Host-chips",
  value: "chips-token",
  domain: "widget.test",
  sameSite: "None",
  partitionKey: { topLevelSite: "https://site.test", hasCrossSiteAncestor: true },
};
const persistent: SessionCookieSnapshot.CdpCookie = {
  ...hostOnly,
  name: "remember",
  session: false,
  expires: 4_000_000_000,
};
const opaque: SessionCookieSnapshot.CdpCookie = { ...partitioned, partitionKeyOpaque: true };

describe("SessionCookieSnapshot", () => {
  it.effect("round-trips session cookie attributes and partition keys without an expiry", () =>
    withStorage((storagePath) =>
      Effect.gen(function* () {
        const source = makeChannel([
          hostOnly,
          hostPrefixed,
          domainWide,
          partitioned,
          persistent,
          opaque,
        ]);
        assert.strictEqual(yield* SessionCookieSnapshot.save(storagePath, source.channel), 4);

        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stored = yield* fileSystem.readFileString(
          SessionCookieSnapshot.snapshotPath(path, storagePath),
        );
        assert.notInclude(stored, '"php-session"');

        const target = makeChannel();
        assert.strictEqual(yield* SessionCookieSnapshot.restore(storagePath, target.channel), 4);
        assert.deepStrictEqual(target.written, [
          {
            name: "sid",
            value: "php-session",
            url: "http://app.test/account",
            path: "/account",
            secure: false,
            httpOnly: true,
            sameSite: "Lax",
            sourceScheme: "NonSecure",
            sourcePort: 8080,
          },
          {
            name: "__Host-auth",
            value: "host-token",
            url: "https://secure.test/",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "Strict",
            sourceScheme: "Secure",
            sourcePort: 443,
          },
          {
            name: "sso",
            value: "sso-token",
            domain: ".example.test",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "None",
          },
          {
            name: "__Host-chips",
            value: "chips-token",
            url: "https://widget.test/",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "None",
            sourceScheme: "Secure",
            sourcePort: 443,
            partitionKey: { topLevelSite: "https://site.test", hasCrossSiteAncestor: true },
          },
        ]);
      }),
    ),
  );

  it.effect("never overwrites a cookie the jar already holds", () =>
    withStorage((storagePath) =>
      Effect.gen(function* () {
        yield* SessionCookieSnapshot.save(storagePath, makeChannel([hostOnly, domainWide]).channel);
        const target = makeChannel([{ ...hostOnly, value: "newer", session: false }]);
        assert.strictEqual(yield* SessionCookieSnapshot.restore(storagePath, target.channel), 1);
        assert.deepStrictEqual(
          target.written.map((params) => ("name" in params ? params.name : undefined)),
          ["sso"],
        );
      }),
    ),
  );

  it.effect("skips cookies that are not restorable", () =>
    Effect.sync(() => {
      assert.isTrue(SessionCookieSnapshot.isRestorable(hostOnly));
      assert.isTrue(SessionCookieSnapshot.isRestorable(partitioned));
      assert.isFalse(SessionCookieSnapshot.isRestorable(persistent));
      assert.isFalse(SessionCookieSnapshot.isRestorable(opaque));
    }),
  );

  it.effect("writes no file when encryption fails", () =>
    withStorage(
      (storagePath) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            SessionCookieSnapshot.save(storagePath, makeChannel([hostOnly]).channel),
          );
          assert.strictEqual(error.operation, "encrypt");
          const fileSystem = yield* FileSystem.FileSystem;
          assert.deepStrictEqual(yield* fileSystem.readDirectory(storagePath), []);
        }),
      { encryptFails: true },
    ),
  );

  it.effect("removes the snapshot once no session cookies remain", () =>
    withStorage((storagePath) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = SessionCookieSnapshot.snapshotPath(path, storagePath);
        yield* SessionCookieSnapshot.save(storagePath, makeChannel([hostOnly]).channel);
        assert.isTrue(yield* fileSystem.exists(file));
        assert.strictEqual(
          yield* SessionCookieSnapshot.save(storagePath, makeChannel([persistent]).channel),
          0,
        );
        assert.isFalse(yield* fileSystem.exists(file));
        assert.strictEqual(
          yield* SessionCookieSnapshot.restore(storagePath, makeChannel().channel),
          0,
        );
      }),
    ),
  );

  it.effect.each([
    { options: {}, usable: true },
    { options: { backend: "gnome_libsecret" }, usable: true },
    { options: { backend: "basic_text" }, usable: false },
    { options: { available: false }, usable: false },
  ])("treats encryption as usable: $usable for $options", ({ options, usable }) =>
    SessionCookieSnapshot.isEncryptionUsable.pipe(
      Effect.map((actual) => assert.strictEqual(actual, usable)),
      Effect.provide(layerSafeStorage(options)),
    ),
  );
});

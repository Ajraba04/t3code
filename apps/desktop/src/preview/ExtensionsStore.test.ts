import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  EMPTY_BROWSER_EXTENSIONS_DOCUMENT,
  readBrowserExtensionsDocument,
  readExtensionManifest,
  writeBrowserExtensionsDocument,
} from "./ExtensionsStore.ts";

describe("ExtensionsStore", () => {
  it.effect("reads a missing file as empty and round-trips what it writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-ext-store-" });
      const file = path.join(dir, "nested", "browser-extensions.json");

      assert.deepStrictEqual(
        yield* readBrowserExtensionsDocument(file),
        EMPTY_BROWSER_EXTENSIONS_DOCUMENT,
      );
      const document = {
        version: 1 as const,
        profiles: { default: [{ id: "a", path: "/ext/a", enabled: false }] },
      };
      yield* writeBrowserExtensionsDocument(file, document);
      assert.deepStrictEqual(yield* readBrowserExtensionsDocument(file), document);

      yield* fs.writeFileString(file, "{ not json");
      const error = yield* Effect.flip(readBrowserExtensionsDocument(file));
      assert.strictEqual(error.operation, "decode");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("accepts only folders with a usable manifest and shows the localized name", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-ext-manifest-" });
      const folder = (name: string, files: Record<string, string>) =>
        Effect.gen(function* () {
          const root = path.join(dir, name);
          for (const [file, contents] of Object.entries(files)) {
            yield* fs.makeDirectory(path.dirname(path.join(root, file)), { recursive: true });
            yield* fs.writeFileString(path.join(root, file), contents);
          }
          return root;
        });
      const reason = (directory: string) =>
        readExtensionManifest(directory).pipe(
          Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "ok" }),
        );

      const plain = yield* folder("plain", {
        // Chrome tolerates comments and trailing commas here.
        "manifest.json": `{ // test\n "manifest_version": 3, "name": "Plain", "version": "1.2", }`,
      });
      assert.deepStrictEqual(yield* readExtensionManifest(plain), {
        name: "Plain",
        version: "1.2",
      });

      const localized = yield* folder("localized", {
        "manifest.json": JSON.stringify({
          manifest_version: 3,
          name: "__MSG_extName__",
          version: "8.12.40",
          default_locale: "en",
        }),
        "_locales/en/messages.json": JSON.stringify({ extname: { message: "1Password" } }),
      });
      assert.strictEqual((yield* readExtensionManifest(localized)).name, "1Password");

      const noManifest = yield* folder("empty", { "readme.txt": "" });
      const badVersion = yield* folder("mv1", {
        "manifest.json": JSON.stringify({ manifest_version: 1, name: "Old", version: "1" }),
      });
      const notADirectory = path.join(plain, "manifest.json");
      assert.strictEqual(yield* reason(noManifest), "invalidManifest");
      assert.strictEqual(yield* reason(badVersion), "invalidManifest");
      assert.strictEqual(yield* reason(notADirectory), "notADirectory");
      assert.strictEqual(yield* reason(path.join(dir, "missing")), "notADirectory");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

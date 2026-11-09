import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty, fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const StoredBrowserExtension = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  enabled: Schema.Boolean,
});
export type StoredBrowserExtension = typeof StoredBrowserExtension.Type;

/** Keyed by browser profile id: an extension applies to that profile in every environment. */
export const BrowserExtensionsDocument = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Record(Schema.String, Schema.Array(StoredBrowserExtension)),
});
export type BrowserExtensionsDocument = typeof BrowserExtensionsDocument.Type;

export const EMPTY_BROWSER_EXTENSIONS_DOCUMENT: BrowserExtensionsDocument = {
  version: 1,
  profiles: {},
};

const decodeDocument = Schema.decodeEffect(fromLenientJson(BrowserExtensionsDocument));
const encodeDocument = Schema.encodeEffect(fromJsonStringPretty(BrowserExtensionsDocument));

export class BrowserExtensionsStoreError extends Schema.TaggedError<BrowserExtensionsStoreError>()(
  "BrowserExtensionsStoreError",
  {
    operation: Schema.Literals(["read", "decode", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Browser extension settings could not be ${this.operation === "write" ? "saved" : "read"} at ${this.path}.`;
  }
}

/** A request the user can fix: the folder, the profile, or the extension it names. */
export class BrowserExtensionRequestError extends Schema.TaggedError<BrowserExtensionRequestError>()(
  "BrowserExtensionRequestError",
  {
    reason: Schema.Literals([
      "notADirectory",
      "invalidManifest",
      "duplicate",
      "ephemeralProfile",
      "unknownExtension",
    ]),
    path: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
  },
) {
  // IPC keeps only the message, so it is the copy the settings page shows.
  override get message(): string {
    switch (this.reason) {
      case "notADirectory":
        return `${this.path ?? "That path"} is not a folder.`;
      case "invalidManifest":
        return `${this.path ?? "That folder"} is not an unpacked extension: ${this.detail ?? "manifest.json is missing or invalid"}.`;
      case "duplicate":
        return "That extension folder is already added to this profile.";
      case "ephemeralProfile":
        return "Extensions cannot run in Incognito.";
      case "unknownExtension":
        return "That extension is no longer in this profile.";
    }
  }
}

export const readBrowserExtensionsDocument = Effect.fn("BrowserExtensionsStore.read")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(Option.none<string>()),
    ),
    Effect.mapError(
      (cause) => new BrowserExtensionsStoreError({ operation: "read", path: filePath, cause }),
    ),
  );
  if (Option.isNone(raw)) return EMPTY_BROWSER_EXTENSIONS_DOCUMENT;
  return yield* decodeDocument(raw.value).pipe(
    Effect.mapError(
      (cause) => new BrowserExtensionsStoreError({ operation: "decode", path: filePath, cause }),
    ),
  );
});

export const writeBrowserExtensionsDocument = Effect.fn("BrowserExtensionsStore.write")(function* (
  filePath: string,
  document: BrowserExtensionsDocument,
) {
  const contents = yield* encodeDocument(document).pipe(
    Effect.mapError(
      (cause) => new BrowserExtensionsStoreError({ operation: "write", path: filePath, cause }),
    ),
  );
  yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
    Effect.mapError(
      (cause) => new BrowserExtensionsStoreError({ operation: "write", path: filePath, cause }),
    ),
  );
});

export const profileExtensions = (
  document: BrowserExtensionsDocument,
  profileId: string,
): ReadonlyArray<StoredBrowserExtension> => document.profiles[profileId] ?? [];

const withProfile = (
  document: BrowserExtensionsDocument,
  profileId: string,
  extensions: ReadonlyArray<StoredBrowserExtension>,
): BrowserExtensionsDocument => {
  const { [profileId]: _previous, ...others } = document.profiles;
  return {
    ...document,
    profiles: extensions.length === 0 ? others : { ...others, [profileId]: extensions },
  };
};

export const addStoredExtension = (
  document: BrowserExtensionsDocument,
  profileId: string,
  extension: StoredBrowserExtension,
): Effect.Effect<BrowserExtensionsDocument, BrowserExtensionRequestError> => {
  const current = profileExtensions(document, profileId);
  return current.some((existing) => existing.path === extension.path)
    ? Effect.fail(new BrowserExtensionRequestError({ reason: "duplicate", path: extension.path }))
    : Effect.succeed(withProfile(document, profileId, [...current, extension]));
};

export const updateStoredExtension = (
  document: BrowserExtensionsDocument,
  profileId: string,
  extensionId: string,
  change: { readonly enabled: boolean } | "remove",
): Effect.Effect<BrowserExtensionsDocument, BrowserExtensionRequestError> => {
  const current = profileExtensions(document, profileId);
  if (!current.some((existing) => existing.id === extensionId)) {
    return Effect.fail(new BrowserExtensionRequestError({ reason: "unknownExtension" }));
  }
  return Effect.succeed(
    withProfile(
      document,
      profileId,
      change === "remove"
        ? current.filter((existing) => existing.id !== extensionId)
        : current.map((existing) =>
            existing.id === extensionId ? { ...existing, enabled: change.enabled } : existing,
          ),
    ),
  );
};

const ManifestShape = Schema.Struct({
  manifest_version: Schema.Literals([2, 3]),
  name: Schema.String,
  version: Schema.String,
  default_locale: Schema.optional(Schema.String),
});
// Chrome accepts comments and trailing commas in manifest.json, so parse leniently.
const decodeManifest = Schema.decodeEffect(fromLenientJson(ManifestShape));
const decodeMessages = Schema.decodeEffect(
  fromLenientJson(
    Schema.Record(Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })),
  ),
);

const MESSAGE_PLACEHOLDER = /^__MSG_(\w+)__$/;

/** Reads the name and version Chrome would show, resolving a `__MSG_name__` from the default locale. */
export const readExtensionManifest = Effect.fn("BrowserExtensionsStore.readManifest")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const invalid = (detail: string) =>
    new BrowserExtensionRequestError({ reason: "invalidManifest", path: directory, detail });
  const info = yield* fs
    .stat(directory)
    .pipe(
      Effect.mapError(
        () => new BrowserExtensionRequestError({ reason: "notADirectory", path: directory }),
      ),
    );
  if (info.type !== "Directory") {
    return yield* new BrowserExtensionRequestError({ reason: "notADirectory", path: directory });
  }
  const raw = yield* fs
    .readFileString(path.join(directory, "manifest.json"))
    .pipe(Effect.mapError(() => invalid("it has no manifest.json")));
  const manifest = yield* decodeManifest(raw).pipe(
    Effect.mapError(() =>
      invalid("manifest.json needs manifest_version 2 or 3, a name and a version"),
    ),
  );
  const placeholder = MESSAGE_PLACEHOLDER.exec(manifest.name)?.[1];
  if (placeholder === undefined || manifest.default_locale === undefined) {
    return { name: manifest.name, version: manifest.version };
  }
  const key = placeholder.toLowerCase();
  const localized = yield* fs
    .readFileString(path.join(directory, "_locales", manifest.default_locale, "messages.json"))
    .pipe(
      Effect.flatMap(decodeMessages),
      Effect.map(
        (messages) =>
          Object.entries(messages).find(([name]) => name.toLowerCase() === key)?.[1].message,
      ),
      Effect.orElseSucceed(() => undefined),
    );
  return { name: localized ?? manifest.name, version: manifest.version };
});

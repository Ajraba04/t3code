import type { Session } from "electron";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";

// Electron never persists session cookies (electron#9995, wontfix), so persistent preview
// partitions keep an encrypted copy beside their own storage and restore it before guests load.
// Reads and writes go through CDP: Electron's cookies API drops partitionKey for CHIPS cookies.
const SNAPSHOT_FILE_NAME = "T3SessionCookies.enc";
const RESTORE_WAIT_LIMIT = Duration.seconds(5);

/** A DevTools protocol connection to some webContents in the partition being saved or restored. */
export interface CookieChannel {
  readonly send: (method: string, params?: object) => Promise<unknown>;
}

const PartitionKey = Schema.Struct({
  topLevelSite: Schema.String,
  hasCrossSiteAncestor: Schema.Boolean,
});

const SnapshotCookie = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  domain: Schema.String,
  path: Schema.String,
  secure: Schema.Boolean,
  httpOnly: Schema.Boolean,
  sameSite: Schema.optionalKey(Schema.Literals(["Strict", "Lax", "None"])),
  sourceScheme: Schema.optionalKey(Schema.Literals(["Unset", "NonSecure", "Secure"])),
  sourcePort: Schema.optionalKey(Schema.Number),
  partitionKey: Schema.optionalKey(PartitionKey),
});
type SnapshotCookie = typeof SnapshotCookie.Type;

/** Network.Cookie as CDP reports it; extra fields are ignored. */
const CdpCookie = Schema.Struct({
  ...SnapshotCookie.fields,
  session: Schema.Boolean,
  partitionKeyOpaque: Schema.optionalKey(Schema.Boolean),
});
export type CdpCookie = typeof CdpCookie.Type;
const decodeAllCookies = Schema.decodeUnknownEffect(
  Schema.Struct({ cookies: Schema.Array(CdpCookie) }),
);

const SnapshotDocument = Schema.Struct({
  version: Schema.Literal(1),
  cookies: Schema.Array(SnapshotCookie),
});
const SnapshotDocumentJson = Schema.fromJsonString(SnapshotDocument);
const decodeSnapshotDocument = Schema.decodeEffect(SnapshotDocumentJson);
const encodeSnapshotDocument = Schema.encodeEffect(SnapshotDocumentJson);

export class SessionCookieSnapshotError extends Schema.TaggedError<SessionCookieSnapshotError>()(
  "SessionCookieSnapshotError",
  {
    operation: Schema.Literals([
      "open-channel",
      "read-cookies",
      "encode",
      "encrypt",
      "write",
      "read-file",
      "decrypt",
      "decode",
      "remove",
    ]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Session cookie snapshot failed during ${this.operation} at ${this.path}.`;
  }
}

/** An opaque partition key (sandboxed or data: top-level frames) cannot be set again. */
export const isRestorable = (cookie: CdpCookie): boolean =>
  cookie.session && cookie.partitionKeyOpaque !== true && cookie.domain.length > 0;

const encodeSnapshotCookie = Schema.encodeSync(SnapshotCookie);

const cookieKey = (cookie: SnapshotCookie): string =>
  JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey?.topLevelSite ?? "",
  ]);

/**
 * Network.CookieParam with no expiry, so it stays a session cookie in the live jar.
 * Host-only cookies are set through `url` alone; a `domain` would widen them to subdomains.
 */
const toCookieParam = (cookie: SnapshotCookie) => {
  // __Host- cookies are only accepted when secure, host-only and scoped to "/".
  const hostPrefixed = cookie.name.startsWith("__Host-");
  const secure = cookie.secure || hostPrefixed;
  const path = hostPrefixed ? "/" : cookie.path;
  const domainCookie = cookie.domain.startsWith(".") && !hostPrefixed;
  const host = cookie.domain.replace(/^\./, "");
  return {
    name: cookie.name,
    value: cookie.value,
    ...(domainCookie
      ? { domain: cookie.domain }
      : { url: `${secure ? "https" : "http"}://${host}${path}` }),
    path,
    secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite === undefined ? {} : { sameSite: cookie.sameSite }),
    ...(cookie.sourceScheme === undefined ? {} : { sourceScheme: cookie.sourceScheme }),
    ...(cookie.sourcePort === undefined ? {} : { sourcePort: cookie.sourcePort }),
    ...(cookie.partitionKey === undefined ? {} : { partitionKey: cookie.partitionKey }),
  };
};

const readAllCookies = (channel: CookieChannel, file: string) =>
  Effect.tryPromise(() => channel.send("Network.getAllCookies")).pipe(
    Effect.flatMap(decodeAllCookies),
    Effect.map(({ cookies }) => cookies),
    Effect.mapError(
      (cause) => new SessionCookieSnapshotError({ operation: "read-cookies", path: file, cause }),
    ),
  );

export const snapshotPath = (path: Path.Path, storagePath: string): string =>
  path.join(storagePath, SNAPSHOT_FILE_NAME);

/** Linux's basic_text backend stores a hardcoded key, which is no protection for sign-ins. */
export const isEncryptionUsable = Effect.gen(function* () {
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const available = yield* safeStorage.isEncryptionAvailable.pipe(
    Effect.orElseSucceed(() => false),
  );
  if (!available) return false;
  const backend = yield* safeStorage.selectedStorageBackend;
  return !Option.contains(backend, "basic_text");
});

export const remove = Effect.fn("SessionCookieSnapshot.remove")(function* (storagePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = snapshotPath(yield* Path.Path, storagePath);
  yield* fileSystem
    .remove(file, { force: true })
    .pipe(
      Effect.mapError(
        (cause) => new SessionCookieSnapshotError({ operation: "remove", path: file, cause }),
      ),
    );
});

export const hasSnapshot = Effect.fn("SessionCookieSnapshot.hasSnapshot")(function* (
  storagePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const file = snapshotPath(yield* Path.Path, storagePath);
  return yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
});

export const save = Effect.fn("SessionCookieSnapshot.save")(function* (
  storagePath: string,
  channel: CookieChannel,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const file = snapshotPath(path, storagePath);
  const cookies = yield* readAllCookies(channel, file);
  // Encoding through the snapshot schema drops session, expires and the other live-only fields.
  const restorable = cookies.filter(isRestorable).map((cookie) => encodeSnapshotCookie(cookie));
  if (restorable.length === 0) {
    yield* remove(storagePath);
    return 0;
  }
  const encoded = yield* encodeSnapshotDocument({ version: 1, cookies: restorable }).pipe(
    Effect.mapError(
      (cause) => new SessionCookieSnapshotError({ operation: "encode", path: file, cause }),
    ),
  );
  const encrypted = yield* safeStorage
    .encryptString(encoded)
    .pipe(
      Effect.mapError(
        (cause) => new SessionCookieSnapshotError({ operation: "encrypt", path: file, cause }),
      ),
    );
  const tempPath = `${file}.${process.pid}.tmp`;
  yield* fileSystem.writeFile(tempPath, encrypted, { mode: 0o600 }).pipe(
    Effect.andThen(fileSystem.rename(tempPath, file)),
    Effect.mapError(
      (cause) => new SessionCookieSnapshotError({ operation: "write", path: file, cause }),
    ),
    Effect.onError(() => fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
  );
  return restorable.length;
});

/** Never overwrites a cookie the jar already holds, which is newer than any snapshot. */
export const restore = Effect.fn("SessionCookieSnapshot.restore")(function* (
  storagePath: string,
  channel: CookieChannel,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const file = snapshotPath(path, storagePath);
  if (!(yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false)))) return 0;
  const encrypted = yield* fileSystem
    .readFile(file)
    .pipe(
      Effect.mapError(
        (cause) => new SessionCookieSnapshotError({ operation: "read-file", path: file, cause }),
      ),
    );
  const decrypted = yield* safeStorage
    .decryptString(encrypted)
    .pipe(
      Effect.mapError(
        (cause) => new SessionCookieSnapshotError({ operation: "decrypt", path: file, cause }),
      ),
    );
  const document = yield* decodeSnapshotDocument(decrypted).pipe(
    Effect.mapError(
      (cause) => new SessionCookieSnapshotError({ operation: "decode", path: file, cause }),
    ),
  );
  const present = new Set((yield* readAllCookies(channel, file)).map(cookieKey));
  // One cookie per command: Network.setCookies rejects the whole batch for one invalid entry.
  const restored = yield* Effect.forEach(
    document.cookies.filter((cookie) => !present.has(cookieKey(cookie))),
    (cookie) =>
      Effect.tryPromise(() => channel.send("Network.setCookie", toCookieParam(cookie))).pipe(
        Effect.as(1),
        Effect.orElseSucceed(() => 0),
      ),
    { concurrency: 8 },
  );
  return restored.reduce((total, count) => total + count, 0);
});

// Keyed by the Electron Session so callers that only hold the session can wait for its restore.
const pendingRestores = new WeakMap<Session, Deferred.Deferred<void>>();

export const markRestoring = Effect.fn("SessionCookieSnapshot.markRestoring")(function* (
  session: Session,
) {
  const restored = yield* Deferred.make<void>();
  pendingRestores.set(session, restored);
  return restored;
});

/** Bounded so a stalled keychain prompt cannot keep a guest from ever attaching. */
export const awaitRestored = Effect.fn("SessionCookieSnapshot.awaitRestored")(function* (
  session: Session,
) {
  const restored = pendingRestores.get(session);
  if (restored === undefined) return;
  yield* Deferred.await(restored).pipe(Effect.timeoutOption(RESTORE_WAIT_LIMIT));
});

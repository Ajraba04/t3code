import { DEFAULT_BROWSER_KEEP_SESSION_COOKIES } from "@t3tools/contracts";
import type { Session, WebContents } from "electron";
import { BrowserWindow, WebContentsView, session } from "electron";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as SessionCookieSnapshot from "./SessionCookieSnapshot.ts";

const PREVIEW_PARTITION_PREFIX = "persist:t3code-preview-";
/** Ephemeral partitions omit persist: but retain a product prefix so the webview gate recognizes them. */
const PREVIEW_EPHEMERAL_PARTITION_PREFIX = "t3code-preview-ephemeral-";
const PROFILE_PARTITION_MARKER = "profile-";
// Coalesces bursts of cookie changes without resetting, so a write is never more than this late.
const SESSION_COOKIE_SAVE_DELAY = Duration.seconds(3);
// Shutdown waits on this only as long as the rest of quit takes anyway.
const SESSION_COOKIE_SHUTDOWN_SAVE_LIMIT = Duration.seconds(3);

export type BrowserSessionPartitionNamespace = "profile";

// Electron's clipboard API uses clipboard-sanitized-write and checks both permission handlers.
const ALLOWED_PREVIEW_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "geolocation",
  // DesktopWindow confines HTML fullscreen to the guest's webview.
  "fullscreen",
  "pointerLock",
  // Loopback requests already succeed in Electron 44; permission-aware sign-in widgets query first.
  "loopback-network",
  // Deny local-fonts to untrusted previews: it exposes installed-font fingerprints and file bytes.
  // Deny notifications: pages could impersonate T3 Code; app notifications use the default session.
]);

const NEVER_EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "devtools:",
  "file:",
  "filesystem:",
  "http:",
  "https:",
  "javascript:",
  "view-source:",
]);

const externalProtocolPromptUrl = (rawUrl: string | undefined): string | null => {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    return NEVER_EXTERNAL_PROTOCOLS.has(url.protocol) ? null : url.href;
  } catch {
    return null;
  }
};

// Teams sends Electron User-Agents to an error page before sign-in. Electron allows one listener per session.
const TEAMS_URL_PATTERNS = ["https://teams.cloud.microsoft/*", "https://teams.microsoft.com/*"];

const MAX_PROMPT_URL_LENGTH = 300;

const truncateForPrompt = (text: string): string =>
  text.length > MAX_PROMPT_URL_LENGTH ? `${text.slice(0, MAX_PROMPT_URL_LENGTH)}…` : text;

const permissionOrigin = (rawUrl: string | undefined): string | null => {
  if (!rawUrl) return null;
  try {
    const { origin } = new URL(rawUrl);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
};

export class BrowserSessionPartitionDerivationError extends Schema.TaggedError<BrowserSessionPartitionDerivationError>()(
  "BrowserSessionPartitionDerivationError",
  {
    scope: Schema.String,
    cause: Schema.instanceOf(PlatformError.PlatformError),
  },
) {
  override get message(): string {
    return `Failed to derive a desktop preview browser partition for scope ${this.scope}.`;
  }
}

export class BrowserSessionCreationError extends Schema.TaggedError<BrowserSessionCreationError>()(
  "BrowserSessionCreationError",
  {
    scope: Schema.String,
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create a desktop preview browser session for scope ${this.scope} (partition ${this.partition}).`;
  }
}

export class BrowserSessionStorageClearError extends Schema.TaggedError<BrowserSessionStorageClearError>()(
  "BrowserSessionStorageClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear desktop preview browser storage for partition ${this.partition}.`;
  }
}

export class BrowserSessionCacheClearError extends Schema.TaggedError<BrowserSessionCacheClearError>()(
  "BrowserSessionCacheClearError",
  {
    partition: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clear the desktop preview browser cache for partition ${this.partition}.`;
  }
}

export const BrowserSessionGetSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
]);
export type BrowserSessionGetSessionError = typeof BrowserSessionGetSessionError.Type;

export const BrowserSessionError = Schema.Union([
  BrowserSessionPartitionDerivationError,
  BrowserSessionCreationError,
  BrowserSessionStorageClearError,
  BrowserSessionCacheClearError,
]);
export type BrowserSessionError = typeof BrowserSessionError.Type;

export class BrowserSession extends Context.Service<
  BrowserSession,
  {
    readonly getPartition: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSessionPartitionNamespace,
    ) => Effect.Effect<string, BrowserSessionPartitionDerivationError>;
    readonly isPartition: (partition: string) => boolean;
    readonly getSession: (
      scope?: string,
      persistent?: boolean,
      namespace?: BrowserSessionPartitionNamespace,
    ) => Effect.Effect<Session, BrowserSessionGetSessionError>;
    /** Omit `partitions` to clear every known partition. */
    readonly clearCookies: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, BrowserSessionStorageClearError>;
    readonly clearCache: (
      partitions?: ReadonlyArray<string>,
    ) => Effect.Effect<void, BrowserSessionCacheClearError>;
  }
>()("@t3tools/desktop/preview/BrowserSession") {}

/**
 * A hidden page in the partition with its own debugger, because guests' debuggers belong to
 * PreviewManager. A WebContentsView, unlike a window, never counts toward window-all-closed.
 */
const openCookieChannel = (partition: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const view = new WebContentsView({
          webPreferences: { partition, sandbox: true, javascript: false },
        });
        try {
          await view.webContents.loadURL("about:blank");
          view.webContents.debugger.attach("1.3");
          return view;
        } catch (cause) {
          view.webContents.close();
          throw cause;
        }
      },
      catch: (cause) =>
        new SessionCookieSnapshot.SessionCookieSnapshotError({
          operation: "open-channel",
          path: partition,
          cause,
        }),
    }),
    (view) =>
      Effect.sync(() => {
        if (!view.webContents.isDestroyed()) view.webContents.close();
      }),
  ).pipe(
    Effect.map((view): SessionCookieSnapshot.CookieChannel => ({
      send: (method, params) => view.webContents.debugger.sendCommand(method, params),
    })),
  );

export class BrowserSessionCookies extends Context.Service<
  BrowserSessionCookies,
  {
    /** Saves session-cookie snapshots whose save delay has not elapsed yet; bounded for quit. */
    readonly flushPending: Effect.Effect<void>;
  }
>()("@t3tools/desktop/preview/BrowserSession/BrowserSessionCookies") {}

const selectSessions = (
  sessions: ReadonlyMap<string, Session>,
  partitions: ReadonlyArray<string> | undefined,
): ReadonlyArray<readonly [string, Session]> =>
  [...sessions.entries()].filter(
    ([partition]) => partitions === undefined || partitions.includes(partition),
  );

/** Escape lone surrogates before UTF-8 hashing, which otherwise merges them with U+FFFD; escape backslashes too. */
const encodeScopeForDigest = (scope: string): Uint8Array =>
  new TextEncoder().encode(
    scope
      .replace(/\\/g, "\\\\")
      .replace(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
        (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
  );

// Webview guests have no window; use their embedding page.
const previewHostWindow = (guest: WebContents | null): BrowserWindow | undefined => {
  if (guest === null || guest.isDestroyed()) return undefined;
  const host = guest.hostWebContents ?? guest;
  if (host.isDestroyed()) return undefined;
  return BrowserWindow.fromWebContents(host) ?? undefined;
};

/** @public */
export const make = Effect.gen(function* BrowserSessionMake() {
  const crypto = yield* Digest.Digest;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const snapshotServices = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ElectronSafeStorage.ElectronSafeStorage
  >();
  const runFork = Effect.runForkWith(snapshotServices);
  // One prompt at a time, so a page cannot stack dialogs by looping a deep link.
  let permissionPromptOpen = false;
  /** Settles with `undefined` when the user gave no answer: another prompt was open or the dialog failed. */
  const promptPermission = (
    requester: WebContents | null,
    prompt: {
      readonly buttons: readonly [allow: string, deny: string];
      readonly message: string;
      readonly detail?: string;
    },
    callback: (answer: boolean | undefined) => void,
  ): void => {
    if (permissionPromptOpen) {
      callback(undefined);
      return;
    }
    permissionPromptOpen = true;
    const settle = (answer: boolean | undefined) =>
      Effect.sync(() => {
        permissionPromptOpen = false;
        callback(answer);
      });
    runFork(
      electronDialog
        .showMessageBox(
          {
            type: "question",
            buttons: [...prompt.buttons],
            // Default to deny so an Enter typed into the page cannot accept a prompt it raised.
            defaultId: 1,
            cancelId: 1,
            message: prompt.message,
            ...(prompt.detail === undefined ? {} : { detail: prompt.detail }),
          },
          previewHostWindow(requester),
        )
        .pipe(
          Effect.map(({ response }): boolean | undefined => response === 0),
          Effect.orElseSucceed(() => undefined),
          Effect.flatMap(settle),
          Effect.onInterrupt(() => settle(undefined)),
        ),
    );
  };
  /** Electron launches external protocols after granting openExternal; untrusted pages require confirmation. */
  const confirmOpenExternal = (
    requester: WebContents | null,
    rawUrl: string | undefined,
    callback: (granted: boolean) => void,
  ): void => {
    const url = externalProtocolPromptUrl(rawUrl);
    if (url === null) {
      callback(false);
      return;
    }
    promptPermission(
      requester,
      {
        buttons: ["Open", "Cancel"],
        message: `Open this ${new URL(url).protocol.slice(0, -1)} link?`,
        detail: `A page in the browser wants to open another application:\n\n${truncateForPrompt(url)}`,
      },
      (answer) => callback(answer === true),
    );
  };
  const sessionsRef = yield* SynchronizedRef.make<ReadonlyMap<string, Session>>(new Map());

  interface TrackedSessionCookies {
    readonly partition: string;
    readonly storagePath: string;
    readonly session: Session;
    readonly restored: Deferred.Deferred<void>;
  }
  const trackedSessionCookies = new Map<string, TrackedSessionCookies>();
  const pendingSessionCookieSaves = new Set<string>();

  const keepSessionCookies = Effect.gen(function* () {
    const settings = yield* clientSettings.get.pipe(Effect.orElseSucceed(() => Option.none()));
    const enabled = Option.match(settings, {
      onNone: () => DEFAULT_BROWSER_KEEP_SESSION_COOKIES,
      onSome: (value) => value.browserKeepSessionCookies,
    });
    return enabled && (yield* SessionCookieSnapshot.isEncryptionUsable);
  });

  const restoreSessionCookies = Effect.fn("BrowserSession.restoreSessionCookies")(
    function* (tracked: TrackedSessionCookies) {
      if (!(yield* keepSessionCookies)) {
        yield* SessionCookieSnapshot.remove(tracked.storagePath);
        return;
      }
      if (!(yield* SessionCookieSnapshot.hasSnapshot(tracked.storagePath))) return;
      const restored = yield* Effect.scoped(
        Effect.flatMap(openCookieChannel(tracked.partition), (channel) =>
          SessionCookieSnapshot.restore(tracked.storagePath, channel),
        ),
      );
      yield* Effect.annotateCurrentSpan({ restored });
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not restore session cookies.", cause)),
  );

  const syncSessionCookieSnapshot = Effect.fn("BrowserSession.syncSessionCookieSnapshot")(
    function* (tracked: TrackedSessionCookies) {
      // A save before restore finishes would replace the snapshot with a partial jar.
      yield* Deferred.await(tracked.restored);
      if (!(yield* keepSessionCookies)) {
        yield* SessionCookieSnapshot.remove(tracked.storagePath);
        return;
      }
      // Electron's API cannot see partition keys, but it can cheaply tell when there is nothing to save.
      const sessionCookies = yield* Effect.tryPromise({
        try: () => tracked.session.cookies.get({ session: true }),
        catch: (cause) =>
          new SessionCookieSnapshot.SessionCookieSnapshotError({
            operation: "read-cookies",
            path: tracked.storagePath,
            cause,
          }),
      });
      if (sessionCookies.length === 0) {
        yield* SessionCookieSnapshot.remove(tracked.storagePath);
        return;
      }
      const saved = yield* Effect.scoped(
        Effect.flatMap(openCookieChannel(tracked.partition), (channel) =>
          SessionCookieSnapshot.save(tracked.storagePath, channel),
        ),
      );
      yield* Effect.annotateCurrentSpan({ saved });
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not save session cookies.", cause)),
  );

  const scheduleSessionCookieSave = (partition: string, tracked: TrackedSessionCookies): void => {
    if (pendingSessionCookieSaves.has(partition)) return;
    pendingSessionCookieSaves.add(partition);
    runFork(
      Effect.sleep(SESSION_COOKIE_SAVE_DELAY).pipe(
        Effect.andThen(Effect.sync(() => pendingSessionCookieSaves.delete(partition))),
        Effect.andThen(syncSessionCookieSnapshot(tracked)),
      ),
    );
  };

  const trackSessionCookies = Effect.fn("BrowserSession.trackSessionCookies")(
    function* (partition: string, browserSession: Session) {
      const storagePath: unknown = browserSession.storagePath;
      if (typeof storagePath !== "string") return;
      const tracked: TrackedSessionCookies = {
        partition,
        storagePath,
        session: browserSession,
        restored: yield* SessionCookieSnapshot.markRestoring(browserSession),
      };
      trackedSessionCookies.set(partition, tracked);
      browserSession.cookies.on("changed", (_event, cookie) => {
        if (cookie.session === true) scheduleSessionCookieSave(partition, tracked);
      });
      runFork(
        restoreSessionCookies(tracked).pipe(
          Effect.ensuring(Deferred.succeed(tracked.restored, undefined)),
        ),
      );
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not track session cookies.", cause)),
  );

  // Snapshots are current except for changes still inside their save delay.
  const flushPending = Effect.suspend(() =>
    Effect.forEach(
      [...trackedSessionCookies.values()].filter((tracked) =>
        pendingSessionCookieSaves.has(tracked.partition),
      ),
      syncSessionCookieSnapshot,
      { concurrency: "unbounded", discard: true },
    ),
  ).pipe(
    Effect.timeoutOption(SESSION_COOKIE_SHUTDOWN_SAVE_LIMIT),
    Effect.asVoid,
    Effect.provideContext(snapshotServices),
    Effect.withSpan("BrowserSession.flushPendingSessionCookies"),
  );

  const getPartition = Effect.fn("BrowserSession.getPartition")(function* (
    scope = "shared",
    persistent = true,
    namespace?: BrowserSessionPartitionNamespace,
  ) {
    const digest = yield* crypto.digest(Digest.sha256, encodeScopeForDigest(scope)).pipe(
      Effect.mapError(
        (cause) =>
          new BrowserSessionPartitionDerivationError({
            scope,
            cause,
          }),
      ),
    );
    const prefix = persistent ? PREVIEW_PARTITION_PREFIX : PREVIEW_EPHEMERAL_PARTITION_PREFIX;
    return `${prefix}${namespace === "profile" ? PROFILE_PARTITION_MARKER : ""}${Hex.encode(digest).slice(0, 20)}`;
  });

  const getSession = Effect.fn("BrowserSession.getSession")(function* (
    scope = "shared",
    persistent = true,
    namespace?: BrowserSessionPartitionNamespace,
  ) {
    const partition = yield* getPartition(scope, persistent, namespace);
    return yield* SynchronizedRef.modifyEffect(sessionsRef, (sessions) => {
      const existing = sessions.get(partition);
      if (existing) return Effect.succeed([existing, sessions] as const);
      const created = Effect.try({
        try: () => {
          const browserSession = session.fromPartition(partition);
          // Like Chrome, clipboard reads ask once per origin; both answers last for the session.
          const clipboardReadDecisions = new Map<string, boolean>();
          const confirmClipboardRead = (
            requester: WebContents,
            rawUrl: string | undefined,
            callback: (granted: boolean) => void,
          ): void => {
            const origin = permissionOrigin(rawUrl);
            if (origin === null) {
              callback(false);
              return;
            }
            const remembered = clipboardReadDecisions.get(origin);
            if (remembered !== undefined) {
              callback(remembered);
              return;
            }
            promptPermission(
              requester,
              {
                buttons: ["Allow", "Block"],
                message: `${truncateForPrompt(origin)} wants to see text and images copied to the clipboard`,
              },
              (answer) => {
                if (answer !== undefined) clipboardReadDecisions.set(origin, answer);
                callback(answer === true);
              },
            );
          };
          // Rewriting Electron's native User-Agent makes Turnstile fail integrity checks with error 600010.
          browserSession.setPermissionRequestHandler(
            (webContents, permission, callback, details) => {
              if (permission === "openExternal") {
                confirmOpenExternal(
                  webContents,
                  "externalURL" in details ? details.externalURL : undefined,
                  callback,
                );
                return;
              }
              if (permission === "clipboard-read") {
                confirmClipboardRead(
                  webContents,
                  "requestingUrl" in details ? details.requestingUrl : undefined,
                  callback,
                );
                return;
              }
              callback(ALLOWED_PREVIEW_PERMISSIONS.has(permission));
            },
          );
          browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) =>
            permission === "clipboard-read"
              ? clipboardReadDecisions.get(permissionOrigin(requestingOrigin) ?? "") === true
              : ALLOWED_PREVIEW_PERMISSIONS.has(permission),
          );
          browserSession.webRequest.onBeforeSendHeaders(
            { urls: TEAMS_URL_PATTERNS },
            ({ requestHeaders }, callback) => {
              const userAgent = Object.entries(requestHeaders).find(
                ([name]) => name.toLowerCase() === "user-agent",
              );
              if (userAgent === undefined) {
                callback({});
                return;
              }
              const [name, value] = userAgent;
              callback({
                requestHeaders: { ...requestHeaders, [name]: value.replace(/ Electron\/\S+/, "") },
              });
            },
          );
          const next = new Map(sessions);
          next.set(partition, browserSession);
          return [browserSession, next] as const;
        },
        catch: (cause) =>
          new BrowserSessionCreationError({
            scope,
            partition,
            cause,
          }),
      });
      // Tracking inside the lock registers the restore before any caller can see the session.
      return persistent
        ? created.pipe(
            Effect.tap(([browserSession]) => trackSessionCookies(partition, browserSession)),
          )
        : created;
    });
  });

  const service = BrowserSession.of({
    getPartition,
    isPartition: (partition) =>
      partition.startsWith(PREVIEW_PARTITION_PREFIX) ||
      partition.startsWith(PREVIEW_EPHEMERAL_PARTITION_PREFIX),
    getSession,
    clearCookies: Effect.fn("BrowserSession.clearCookies")(function* (partitions?) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.forEach(
        selectSessions(sessions, partitions),
        ([partition, browserSession]) =>
          Effect.tryPromise({
            try: () =>
              browserSession.clearStorageData({
                storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"],
              }),
            catch: (cause) =>
              new BrowserSessionStorageClearError({
                partition,
                cause,
              }),
          }).pipe(
            Effect.andThen(
              Effect.suspend(() => {
                const tracked = trackedSessionCookies.get(partition);
                return tracked === undefined
                  ? Effect.void
                  : SessionCookieSnapshot.remove(tracked.storagePath).pipe(
                      Effect.provideContext(snapshotServices),
                      Effect.mapError(
                        (cause) => new BrowserSessionStorageClearError({ partition, cause }),
                      ),
                    );
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );
    }),
    clearCache: Effect.fn("BrowserSession.clearCache")(function* (partitions?) {
      const sessions = yield* SynchronizedRef.get(sessionsRef);
      yield* Effect.forEach(
        selectSessions(sessions, partitions),
        ([partition, browserSession]) =>
          Effect.tryPromise({
            try: () => browserSession.clearCache(),
            catch: (cause) =>
              new BrowserSessionCacheClearError({
                partition,
                cause,
              }),
          }),
        { concurrency: "unbounded", discard: true },
      );
    }),
  });
  return Context.make(BrowserSession, service).pipe(
    Context.add(BrowserSessionCookies, BrowserSessionCookies.of({ flushPending })),
  );
}).pipe(Effect.withSpan("BrowserSession.make"));

export const layer = Layer.effectContext(make);

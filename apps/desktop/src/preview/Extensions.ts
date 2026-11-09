/**
 * BrowserExtensions - unpacked extensions per browser profile, loaded into that profile's
 * persistent preview sessions through Electron's built-in `session.extensions` API.
 */
import {
  type BrowserExtension,
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  type ManagedPolicyDocument,
  managedPolicyDeniedMessage,
} from "@t3tools/contracts";
import type { ManagedPolicyFileError } from "@t3tools/shared/managedPolicyFile";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { Session } from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import {
  addStoredExtension,
  BrowserExtensionRequestError,
  type BrowserExtensionsDocument,
  BrowserExtensionsStoreError,
  profileExtensions,
  readBrowserExtensionsDocument,
  readExtensionManifest,
  type StoredBrowserExtension,
  updateStoredExtension,
  writeBrowserExtensionsDocument,
} from "./ExtensionsStore.ts";

/** The part of an Electron session the loader drives. */
export type ExtensionSession = Pick<Session, "isPersistent"> & {
  readonly extensions: Pick<Session["extensions"], "loadExtension" | "removeExtension">;
};

export class BrowserExtensionsPolicyError extends Schema.TaggedError<BrowserExtensionsPolicyError>()(
  "BrowserExtensionsPolicyError",
  {
    policyPath: Schema.String,
    /** Absent when the policy could not be read or decoded. */
    organization: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.organization === undefined
      ? `The managed policy at ${this.policyPath} could not be read, so browser extensions are not allowed.`
      : managedPolicyDeniedMessage(this.organization, "browser extensions");
  }
}

type BrowserExtensionsError =
  | BrowserExtensionsPolicyError
  | BrowserExtensionRequestError
  | BrowserExtensionsStoreError;

/** An unreadable policy denies extensions, as it does cookie import: the server refuses it too. */
const checkBrowserExtensionsPolicy = Effect.fn("BrowserExtensions.checkPolicy")(function* <R>(
  readPolicy: Effect.Effect<
    { readonly source: string; readonly document: ManagedPolicyDocument } | undefined,
    ManagedPolicyFileError,
    R
  >,
) {
  const policy = yield* readPolicy.pipe(
    Effect.mapError((cause) => new BrowserExtensionsPolicyError({ policyPath: cause.path })),
  );
  if (policy?.document.limits?.browserExtensions === false) {
    return yield* new BrowserExtensionsPolicyError({
      policyPath: policy.source,
      organization: policy.document.organization,
    });
  }
});

/**
 * The browser profile a preview partition scope belongs to: the inverse of the IPC layer's
 * `resolvePartitionScope`. Undefined for scopes that are not a profile, such as the window's
 * warm-up "shared" session.
 */
export function profileIdForPartitionScope(
  scope: string,
  namespace: "profile" | undefined,
): string | undefined {
  if (namespace === undefined) return scope === "shared" ? undefined : DEFAULT_BROWSER_PROFILE_ID;
  try {
    const parsed: unknown = JSON.parse(scope);
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[1] === "string"
      ? parsed[1]
      : undefined;
  } catch {
    return undefined;
  }
}

export class BrowserExtensions extends Context.Service<
  BrowserExtensions,
  {
    readonly list: (
      profileId: string,
    ) => Effect.Effect<ReadonlyArray<BrowserExtension>, BrowserExtensionsError>;
    /** `directory` must come from the main process's folder picker, never from a renderer. */
    readonly addFolder: (
      profileId: string,
      directory: string,
    ) => Effect.Effect<ReadonlyArray<BrowserExtension>, BrowserExtensionsError>;
    readonly setEnabled: (
      profileId: string,
      extensionId: string,
      enabled: boolean,
    ) => Effect.Effect<ReadonlyArray<BrowserExtension>, BrowserExtensionsError>;
    readonly remove: (
      profileId: string,
      extensionId: string,
    ) => Effect.Effect<ReadonlyArray<BrowserExtension>, BrowserExtensionsError>;
    readonly checkPolicy: Effect.Effect<void, BrowserExtensionsPolicyError>;
    /**
     * Loads the profile's enabled extensions into a newly created persistent session and keeps it
     * in sync with later changes. Idempotent; never fails, since a broken extension must not stop
     * the browser from opening.
     */
    readonly attach: (session: ExtensionSession, profileId: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/preview/BrowserExtensions") {}

interface AttachedSession {
  readonly session: ExtensionSession;
  readonly profileId: string;
  /** Store id to what Electron loaded for it. */
  readonly loaded: Map<string, { readonly electronId: string; readonly path: string }>;
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const managedPolicy = yield* DesktopManagedPolicy.DesktopManagedPolicy;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const storePath = path.join(environment.stateDir, "browser-extensions.json");
  // One lock for the store and every session's loaded set, so a toggle cannot race a load.
  const lock = yield* Semaphore.make(1);
  const attached = new Map<ExtensionSession, AttachedSession>();
  const loadErrors = new Map<string, string>();
  let cachedDocument: BrowserExtensionsDocument | undefined;

  const provideFs = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const checkPolicy = checkBrowserExtensionsPolicy(managedPolicy.read);

  const readDocument = Effect.gen(function* () {
    if (cachedDocument !== undefined) return cachedDocument;
    const document = yield* provideFs(readBrowserExtensionsDocument(storePath));
    cachedDocument = document;
    return document;
  });

  const unload = (state: AttachedSession, extensionId: string) =>
    Effect.sync(() => {
      const loaded = state.loaded.get(extensionId);
      if (loaded === undefined) return;
      state.loaded.delete(extensionId);
      try {
        state.session.extensions.removeExtension(loaded.electronId);
      } catch {
        // Electron already dropped it, for example after a crash.
      }
    });

  const reconcile = Effect.fn("BrowserExtensions.reconcile")(function* (
    state: AttachedSession,
    entries: ReadonlyArray<StoredBrowserExtension>,
  ) {
    const wanted = entries.filter((entry) => entry.enabled);
    for (const [extensionId, loaded] of state.loaded) {
      const entry = wanted.find((candidate) => candidate.id === extensionId);
      if (entry === undefined || entry.path !== loaded.path) yield* unload(state, extensionId);
    }
    for (const entry of entries) {
      if (!entry.enabled) loadErrors.delete(entry.id);
    }
    for (const entry of wanted) {
      if (state.loaded.has(entry.id)) continue;
      const result = yield* Effect.tryPromise({
        try: () => state.session.extensions.loadExtension(entry.path, { allowFileAccess: false }),
        catch: errorText,
      }).pipe(Effect.result);
      if (result._tag === "Success") {
        state.loaded.set(entry.id, { electronId: result.success.id, path: entry.path });
        loadErrors.delete(entry.id);
      } else {
        const message = result.failure;
        loadErrors.set(entry.id, message);
        yield* Effect.logWarning("Browser extension failed to load.", {
          profileId: state.profileId,
          path: entry.path,
          error: message,
        });
      }
    }
  });

  const describe = Effect.fn("BrowserExtensions.describe")(function* (
    entry: StoredBrowserExtension,
  ) {
    const manifest = yield* provideFs(readExtensionManifest(entry.path)).pipe(Effect.result);
    const base = { id: entry.id, path: entry.path, enabled: entry.enabled };
    if (manifest._tag === "Failure") {
      return { ...base, name: null, version: null, error: manifest.failure.message };
    }
    return {
      ...base,
      name: manifest.success.name,
      version: manifest.success.version,
      error: entry.enabled ? (loadErrors.get(entry.id) ?? null) : null,
    } satisfies BrowserExtension;
  });

  const list = Effect.fn("BrowserExtensions.list")(function* (profileId: string) {
    const document = yield* lock.withPermits(1)(readDocument);
    return yield* Effect.forEach(profileExtensions(document, profileId), describe);
  });

  const mutate = (
    profileId: string,
    change: (
      document: BrowserExtensionsDocument,
    ) => Effect.Effect<BrowserExtensionsDocument, BrowserExtensionsError>,
  ) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          yield* checkPolicy;
          const next = yield* change(yield* readDocument);
          yield* provideFs(writeBrowserExtensionsDocument(storePath, next));
          cachedDocument = next;
          const entries = profileExtensions(next, profileId);
          for (const state of attached.values()) {
            if (state.profileId === profileId) yield* reconcile(state, entries);
          }
        }),
      )
      .pipe(Effect.andThen(list(profileId)));

  const addFolder = Effect.fn("BrowserExtensions.addFolder")(function* (
    profileId: string,
    directory: string,
  ) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      return yield* new BrowserExtensionRequestError({ reason: "ephemeralProfile" });
    }
    const resolved = path.resolve(directory);
    yield* provideFs(readExtensionManifest(resolved));
    const id = yield* random.uuidV4();
    return yield* mutate(profileId, (document) =>
      addStoredExtension(document, profileId, { id, path: resolved, enabled: true }),
    );
  });

  const attach = Effect.fn("BrowserExtensions.attach")(
    function* (session: ExtensionSession, profileId: string) {
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (attached.has(session) || !session.isPersistent()) return;
          // The policy cannot change while the app runs, so a denied session is never revisited.
          yield* checkPolicy;
          const state: AttachedSession = { session, profileId, loaded: new Map() };
          attached.set(session, state);
          yield* reconcile(state, profileExtensions(yield* readDocument, profileId));
        }),
      );
    },
    Effect.catch((error) =>
      Effect.logWarning("Browser extensions were not loaded.", { error: error.message }),
    ),
  );

  return BrowserExtensions.of({
    list,
    addFolder,
    setEnabled: (profileId, extensionId, enabled) =>
      mutate(profileId, (document) =>
        updateStoredExtension(document, profileId, extensionId, { enabled }),
      ).pipe(Effect.withSpan("BrowserExtensions.setEnabled")),
    remove: (profileId, extensionId) =>
      mutate(profileId, (document) =>
        updateStoredExtension(document, profileId, extensionId, "remove").pipe(
          Effect.tap(() => Effect.sync(() => loadErrors.delete(extensionId))),
        ),
      ).pipe(Effect.withSpan("BrowserExtensions.remove")),
    checkPolicy,
    attach,
  });
});

export const layer = Layer.effect(BrowserExtensions, make);

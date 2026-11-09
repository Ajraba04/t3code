/**
 * Lets outside CDP clients share a preview guest's single debugger with T3. Each client sees a
 * browser holding only the registered preview tabs; it never reaches T3's own UI or the debugger
 * attachment itself.
 */
import { fitsPayloadBudget } from "./CdpRelay.ts";

export interface ExternalCdpTabSource {
  readonly send: (
    method: string,
    params: Record<string, unknown>,
    sessionId: string | undefined,
  ) => Promise<unknown>;
  readonly targetId: () => Promise<string>;
  readonly url: () => string;
  readonly title: () => string;
}

type TabListener = (method: string, params: unknown, sessionId: string | undefined) => void;

interface ExecutionContext {
  readonly id: number;
}

export interface ExternalCdpTab {
  readonly id: string;
  readonly source: ExternalCdpTabSource;
  /** Every debugger message for the guest, as Electron reports it ("" for the page itself). */
  readonly event: (method: string, params: unknown, sessionId: string) => void;
  readonly targetInfo: () => Promise<Record<string, unknown>>;
  readonly contexts: (sessionId: string) => ReadonlyArray<ExecutionContext>;
  readonly hasContext: (sessionId: string, id: number) => boolean;
  readonly children: (parentSessionId: string) => ReadonlyArray<Record<string, unknown>>;
  readonly ownsChild: (sessionId: string) => boolean;
  readonly listen: (listener: TabListener) => () => void;
  /** Guests crash on overlapping screenshot copies (crbug.com/567321049); outside clients queue. */
  readonly screenshot: <A>(capture: () => Promise<A>) => Promise<A>;
}

const EXTERNAL_BROWSER_CONTEXT_ID = "t3-preview";

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

export function createExternalCdpTab(id: string, source: ExternalCdpTabSource): ExternalCdpTab {
  const contexts = new Map<string, Map<number, ExecutionContext>>();
  const children = new Map<string, { parent: string; params: Record<string, unknown> }>();
  const listeners = new Set<TabListener>();
  let targetId: Promise<string> | null = null;
  let screenshots: Promise<unknown> = Promise.resolve();

  const contextsOf = (sessionId: string) => {
    let map = contexts.get(sessionId);
    if (!map) contexts.set(sessionId, (map = new Map()));
    return map;
  };

  // Runtime.enable on a debugger that already has it enabled reports no contexts,
  // and setAutoAttach reports no frames already attached, so both are tracked from the start.
  const track = (method: string, params: Record<string, unknown>, sessionId: string) => {
    switch (method) {
      case "Runtime.executionContextCreated": {
        const context = asRecord(params["context"]);
        if (typeof context["id"] === "number") {
          contextsOf(sessionId).set(context["id"], context as unknown as ExecutionContext);
        }
        return;
      }
      case "Runtime.executionContextDestroyed":
        contexts.get(sessionId)?.delete(params["executionContextId"] as number);
        return;
      case "Runtime.executionContextsCleared":
        contexts.delete(sessionId);
        return;
      case "Target.attachedToTarget":
        if (typeof params["sessionId"] === "string") {
          children.set(params["sessionId"], { parent: sessionId, params });
        }
        return;
      case "Target.detachedFromTarget":
        if (typeof params["sessionId"] === "string") {
          children.delete(params["sessionId"]);
          contexts.delete(params["sessionId"]);
        }
        return;
      case "Target.targetInfoChanged": {
        const info = asRecord(params["targetInfo"]);
        for (const child of children.values()) {
          if (asRecord(child.params["targetInfo"])["targetId"] === info["targetId"]) {
            child.params = { ...child.params, targetInfo: info };
          }
        }
        return;
      }
    }
  };

  return {
    id,
    source,
    event: (method, params, sessionId) => {
      track(method, asRecord(params), sessionId);
      for (const listener of listeners) listener(method, params, sessionId || undefined);
    },
    targetInfo: async () => ({
      targetId: await (targetId ??= source.targetId()),
      type: "page",
      title: source.title(),
      url: source.url(),
      attached: true,
      canAccessOpener: false,
      browserContextId: EXTERNAL_BROWSER_CONTEXT_ID,
    }),
    contexts: (sessionId) => [...(contexts.get(sessionId)?.values() ?? [])],
    hasContext: (sessionId, contextId) => contexts.get(sessionId)?.has(contextId) ?? false,
    children: (parent) =>
      [...children.values()].filter((child) => child.parent === parent).map((c) => c.params),
    ownsChild: (sessionId) => children.has(sessionId),
    listen: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    screenshot: (capture) => {
      const turn = screenshots.catch(() => {}).then(capture);
      screenshots = turn;
      return turn;
    },
  };
}

export interface ExternalCdpRegistry {
  readonly tabs: () => ReadonlyArray<ExternalCdpTab>;
  readonly tab: (id: string) => ExternalCdpTab | undefined;
  readonly add: (tab: ExternalCdpTab) => void;
  readonly remove: (id: string) => void;
  /** Tabs with an outside client attached, for the "debugger attached" indicator. */
  readonly attachedTabIds: () => ReadonlyArray<string>;
  readonly disconnect: (tabId: string) => void;
  readonly disconnectAll: () => void;
  readonly onChange: (listener: () => void) => () => void;
}

interface RegisteredClient {
  readonly tabIds: () => ReadonlySet<string>;
  readonly tabAdded: (tab: ExternalCdpTab) => void;
  readonly tabRemoved: (tab: ExternalCdpTab) => void;
  readonly close: () => void;
}

interface ClientRegistry extends ExternalCdpRegistry {
  readonly addClient: (client: RegisteredClient) => () => void;
  readonly changed: () => void;
}

export function createExternalCdpRegistry(): ExternalCdpRegistry {
  const tabs = new Map<string, ExternalCdpTab>();
  const clients = new Set<RegisteredClient>();
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const registry: ClientRegistry = {
    tabs: () => [...tabs.values()],
    tab: (id) => tabs.get(id),
    add: (tab) => {
      if (tabs.has(tab.id)) registry.remove(tab.id);
      tabs.set(tab.id, tab);
      for (const client of clients) client.tabAdded(tab);
    },
    remove: (id) => {
      const tab = tabs.get(id);
      if (!tab) return;
      tabs.delete(id);
      for (const client of clients) client.tabRemoved(tab);
      changed();
    },
    attachedTabIds: () => {
      const ids = new Set<string>();
      for (const client of clients) for (const id of client.tabIds()) ids.add(id);
      return [...ids];
    },
    disconnect: (tabId) => {
      for (const client of clients) if (client.tabIds().has(tabId)) client.close();
    },
    disconnectAll: () => {
      for (const client of clients) client.close();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addClient: (client) => {
      clients.add(client);
      return () => {
        if (clients.delete(client)) changed();
      };
    },
    changed,
  };
  return registry;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

/** Rejected with a CDP protocol error; the message becomes the client's error reply. */
interface CdpProtocolError {
  readonly _tag: "CdpProtocolError";
  readonly message: string;
}
const protocolError = (message: string): CdpProtocolError => ({
  _tag: "CdpProtocolError",
  message,
});
const errorMessage = (cause: unknown) =>
  typeof cause === "object" &&
  cause !== null &&
  typeof (cause as { message?: unknown }).message === "string"
    ? (cause as { message: string }).message
    : String(cause);

/** Events a reply carries, sent just before it as Chromium would. */
const PRECEDE = Symbol("precede");
/** Events sent right after the reply. */
const FOLLOW = Symbol("follow");
type Reply = {
  readonly [PRECEDE]?: ReadonlyArray<Record<string, unknown>>;
  readonly [FOLLOW]?: ReadonlyArray<Record<string, unknown>>;
  readonly result: unknown;
};
const reply = (
  result: unknown,
  extra: { precede?: Array<Record<string, unknown>>; follow?: Array<Record<string, unknown>> } = {},
): Reply => ({
  result,
  ...(extra.precede ? { [PRECEDE]: extra.precede } : {}),
  ...(extra.follow ? { [FOLLOW]: extra.follow } : {}),
});

const ROOT = "";
const ACKNOWLEDGED_BROWSER = new Set([
  "Browser.setDownloadBehavior",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
  "Browser.cancelDownload",
  "Target.activateTarget",
]);
/** Each would close or crash a guest that T3 owns, or reach beyond the shared tabs. */
const REFUSED = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Page.close",
  "Page.crash",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.exposeDevToolsProtocol",
]);
/** T3's own viewers and recordings stream the guest; Chromium allows one screencast per debugger. */
const RESERVED_SCREENCAST = new Set([
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
]);

export interface ExternalCdpClient {
  readonly receive: (raw: string) => void;
  readonly dispose: () => void;
}

export function createExternalCdpClient(options: {
  readonly registry: ExternalCdpRegistry;
  /** Set for a page endpoint: the client's root session is this tab's page. */
  readonly pageTabId?: string;
  readonly product: string;
  readonly userAgent: () => string;
  readonly write: (message: string) => void;
  readonly close: () => void;
}): ExternalCdpClient {
  const registry = options.registry as ClientRegistry;
  let disposed = false;
  let discovering = false;
  let autoAttaching = false;
  let sequence = 0;
  /** The client's own sessions: browser sessions, and page sessions by tab. */
  const sessions = new Map<string, { readonly kind: "browser" } | { readonly tabId: string }>();
  /** Domains each routing key (a page session, the page root, or a frame session) listens to. */
  const subscribed = new Map<string, Set<string>>();
  interface TabUse {
    readonly pageKeys: Set<string>;
    readonly stopListening: () => void;
    readonly scripts: Set<string>;
    readonly domains: Set<string>;
  }
  const uses = new Map<string, TabUse>();

  const send = (message: Record<string, unknown>) => {
    if (disposed) return;
    if (fitsPayloadBudget(message)) {
      options.write(JSON.stringify(message));
      return;
    }
    if (typeof message["id"] === "number") {
      options.write(
        JSON.stringify({
          id: message["id"],
          error: { code: -32000, message: "CDP payload too large" },
          ...(message["sessionId"] === undefined ? {} : { sessionId: message["sessionId"] }),
        }),
      );
      return;
    }
    // A dropped event would leave the client out of step with the page.
    close();
  };
  const route = (key: string) => (key === ROOT ? {} : { sessionId: key });
  const listensTo = (key: string, domain: string) =>
    domain === "Inspector" || (subscribed.get(key)?.has(domain) ?? false);
  const subscribe = (key: string, domain: string) => {
    let domains = subscribed.get(key);
    if (!domains) subscribed.set(key, (domains = new Set()));
    domains.add(domain);
  };

  const useTab = (tab: ExternalCdpTab): TabUse => {
    const existing = uses.get(tab.id);
    if (existing) return existing;
    const use: TabUse = {
      pageKeys: new Set(),
      scripts: new Set(),
      domains: new Set(),
      stopListening: tab.listen((method, params, sessionId) => {
        const domain = method.slice(0, method.indexOf("."));
        // Electron saves a preview's downloads itself; they are not this client's.
        if (method.startsWith("Page.download")) return;
        if (sessionId !== undefined) {
          if (listensTo(sessionId, domain)) send({ method, params, sessionId });
          return;
        }
        for (const key of use.pageKeys) {
          if (listensTo(key, domain)) send({ method, params, ...route(key) });
        }
      }),
    };
    uses.set(tab.id, use);
    return use;
  };

  const newPageSession = (tab: ExternalCdpTab) => {
    const sessionId = `t3-external-page-${++sequence}`;
    sessions.set(sessionId, { tabId: tab.id });
    useTab(tab).pageKeys.add(sessionId);
    registry.changed();
    return sessionId;
  };

  const dropPageSession = (sessionId: string) => {
    const session = sessions.get(sessionId);
    sessions.delete(sessionId);
    subscribed.delete(sessionId);
    if (!session || !("tabId" in session)) return;
    const use = uses.get(session.tabId);
    use?.pageKeys.delete(sessionId);
    if (use && use.pageKeys.size === 0) releaseTab(session.tabId);
    registry.changed();
  };

  /** Undoes what this client left on the shared debugger that would outlive it. */
  const releaseTab = (tabId: string) => {
    const use = uses.get(tabId);
    if (!use) return;
    uses.delete(tabId);
    use.stopListening();
    const tab = registry.tab(tabId);
    if (!tab) return;
    const quietly = (method: string, params: Record<string, unknown> = {}) =>
      void tab.source.send(method, params, undefined).catch(() => {});
    for (const identifier of use.scripts) {
      quietly("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
    // A page left paused would stall T3's agent on the same tab.
    if (use.domains.has("Debugger")) quietly("Debugger.resume");
    if (use.domains.has("Overlay")) quietly("Overlay.hideHighlight");
  };

  const close = () => {
    if (disposed) return;
    dispose();
    options.close();
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const tabId of uses.keys()) releaseTab(tabId);
    sessions.clear();
    unregister();
  };

  const tabOf = (id: string) => {
    const tab = registry.tab(id);
    if (!tab) throw protocolError("This T3 tab has closed.");
    return tab;
  };

  const attachedEvent = async (tab: ExternalCdpTab, sessionId: string) => ({
    method: "Target.attachedToTarget",
    params: { sessionId, targetInfo: await tab.targetInfo(), waitingForDebugger: false },
  });

  const browserCommand = async (command: CdpCommand): Promise<Reply> => {
    const params = command.params ?? {};
    if (ACKNOWLEDGED_BROWSER.has(command.method)) return reply({});
    if (REFUSED.has(command.method)) {
      throw protocolError(`T3 owns this browser; ${command.method} is not available.`);
    }
    switch (command.method) {
      case "Browser.getVersion":
        return reply({
          protocolVersion: "1.3",
          product: options.product,
          revision: "",
          userAgent: options.userAgent(),
          jsVersion: "",
        });
      case "Target.getBrowserContexts":
        return reply({ browserContextIds: [] });
      case "Target.getTargets":
        return reply({
          targetInfos: await Promise.all(registry.tabs().map((tab) => tab.targetInfo())),
        });
      case "Target.getTargetInfo": {
        const wanted = params["targetId"];
        if (typeof wanted === "string") {
          for (const tab of registry.tabs()) {
            const info = await tab.targetInfo();
            if (info["targetId"] === wanted) return reply({ targetInfo: info });
          }
          throw protocolError("No target with given id found");
        }
        return reply({
          targetInfo: {
            targetId: "browser",
            type: "browser",
            title: "",
            url: "",
            attached: true,
            canAccessOpener: false,
          },
        });
      }
      case "Target.setDiscoverTargets": {
        discovering = params["discover"] === true;
        if (!discovering) return reply({});
        const precede = await Promise.all(
          registry.tabs().map(async (tab) => ({
            method: "Target.targetCreated",
            params: { targetInfo: { ...(await tab.targetInfo()), attached: true } },
          })),
        );
        return reply({}, { precede });
      }
      case "Target.attachToBrowserTarget": {
        const sessionId = `t3-external-browser-${++sequence}`;
        sessions.set(sessionId, { kind: "browser" });
        return reply({ sessionId });
      }
      case "Target.attachToTarget": {
        if (params["flatten"] === false) {
          throw protocolError("Only flattened sessions are supported.");
        }
        for (const tab of registry.tabs()) {
          if ((await tab.targetInfo())["targetId"] === params["targetId"]) {
            return reply({ sessionId: newPageSession(tab) });
          }
        }
        throw protocolError("No target with given id found");
      }
      case "Target.detachFromTarget": {
        const sessionId = params["sessionId"];
        if (typeof sessionId === "string" && sessions.has(sessionId)) dropPageSession(sessionId);
        return reply({});
      }
      case "Target.setAutoAttach": {
        autoAttaching = params["autoAttach"] === true;
        if (!autoAttaching) return reply({});
        const follow = await Promise.all(
          registry
            .tabs()
            .filter((tab) => !uses.has(tab.id))
            .map((tab) => attachedEvent(tab, newPageSession(tab))),
        );
        return reply({}, { follow });
      }
      default:
        throw protocolError(`Not supported on T3's CDP endpoint: ${command.method}`);
    }
  };

  const pageCommand = async (
    tab: ExternalCdpTab,
    key: string,
    /** The guest's own session for a frame or worker; the page itself has none. */
    frame: string | undefined,
    command: CdpCommand,
  ): Promise<Reply> => {
    const { method } = command;
    const params = command.params ?? {};
    const dot = method.indexOf(".");
    const domain = method.slice(0, dot);
    const name = method.slice(dot + 1);
    if (domain === "Browser") return browserCommand(command);
    if (REFUSED.has(method)) {
      throw protocolError(`T3 owns this tab; ${method} is not available.`);
    }
    if (domain === "Fetch") {
      throw protocolError("Request interception is not available on a tab T3 shares.");
    }
    if (RESERVED_SCREENCAST.has(method)) {
      throw protocolError("T3 uses this tab's screencast; take screenshots instead.");
    }
    // Disabling a domain on the shared debugger would turn it off for T3 and other clients.
    if (name === "disable") {
      subscribed.get(key)?.delete(domain);
      return reply({});
    }
    // As in T3's relay: focus emulation belongs to the desktop host, and the page never waits.
    if (method === "Emulation.setFocusEmulationEnabled") return reply({});
    if (method === "Runtime.runIfWaitingForDebugger" && frame === undefined) return reply({});
    if (domain === "Target") {
      switch (name) {
        case "setAutoAttach": {
          if (params["autoAttach"] !== true || params["flatten"] !== true) return reply({});
          subscribe(key, "Target");
          // Frames paused on start would hang the page once this client leaves without resuming them.
          const result = await tab.source.send(
            method,
            { ...params, waitForDebuggerOnStart: false },
            frame,
          );
          const precede = tab.children(frame ?? ROOT).map((child) => ({
            method: "Target.attachedToTarget",
            params: { ...child, waitingForDebugger: false },
            ...route(key),
          }));
          return reply(result, { precede });
        }
        case "getTargetInfo":
          return reply(await tab.source.send(method, params, frame));
        case "detachFromTarget":
          return reply({});
        default:
          throw protocolError(`${method} is not available on a T3 tab.`);
      }
    }
    subscribe(key, domain);
    uses.get(tab.id)?.domains.add(domain);
    const scope = frame ?? ROOT;
    if (method === "Runtime.enable") {
      const known = tab.contexts(scope);
      const result = await tab.source.send(method, params, frame);
      const precede = known
        .filter((context) => tab.hasContext(scope, context.id))
        .map((context) => ({
          method: "Runtime.executionContextCreated",
          params: { context },
          ...route(key),
        }));
      return reply(result, { precede });
    }
    const result =
      method === "Page.captureScreenshot" && frame === undefined
        ? await tab.screenshot(() => tab.source.send(method, params, frame))
        : await tab.source.send(method, params, frame);
    if (method === "Page.addScriptToEvaluateOnNewDocument" && frame === undefined) {
      const identifier = (result as { identifier?: unknown } | undefined)?.identifier;
      if (typeof identifier === "string") uses.get(tab.id)?.scripts.add(identifier);
    }
    return reply(result);
  };

  const dispatch = (command: CdpCommand): Promise<Reply> => {
    try {
      const sessionId = command.sessionId;
      if (sessionId === undefined) {
        if (options.pageTabId === undefined) return browserCommand(command);
        return pageCommand(tabOf(options.pageTabId), ROOT, undefined, command);
      }
      const own = sessions.get(sessionId);
      if (own && "kind" in own) return browserCommand(command);
      if (own) return pageCommand(tabOf(own.tabId), sessionId, undefined, command);
      for (const tabId of uses.keys()) {
        const tab = registry.tab(tabId);
        if (tab?.ownsChild(sessionId)) return pageCommand(tab, sessionId, sessionId, command);
      }
      throw protocolError(`Session with given id not found: ${sessionId}`);
    } catch (cause) {
      return Promise.reject(cause);
    }
  };

  const unregister = registry.addClient({
    tabIds: () => new Set(uses.keys()),
    tabAdded: (tab) => {
      if (disposed || options.pageTabId !== undefined) return;
      void (async () => {
        if (discovering) {
          send({ method: "Target.targetCreated", params: { targetInfo: await tab.targetInfo() } });
        }
        if (autoAttaching && !uses.has(tab.id)) send(await attachedEvent(tab, newPageSession(tab)));
      })().catch(() => {});
    },
    tabRemoved: (tab) => {
      if (options.pageTabId === tab.id) {
        close();
        return;
      }
      const use = uses.get(tab.id);
      uses.delete(tab.id);
      use?.stopListening();
      void tab
        .targetInfo()
        .then(({ targetId }) => {
          for (const sessionId of use?.pageKeys ?? []) {
            sessions.delete(sessionId);
            subscribed.delete(sessionId);
            send({ method: "Target.detachedFromTarget", params: { sessionId, targetId } });
          }
          if (discovering) send({ method: "Target.targetDestroyed", params: { targetId } });
        })
        .catch(() => {});
    },
    close,
  });

  if (options.pageTabId !== undefined) {
    const tab = registry.tab(options.pageTabId);
    if (tab) {
      useTab(tab).pageKeys.add(ROOT);
      registry.changed();
    }
  }

  return {
    receive: (raw) => {
      if (disposed) return;
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const routing = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      void dispatch(command).then(
        (value) => {
          for (const event of value[PRECEDE] ?? []) send(event);
          send({ id: command.id, result: value.result ?? {}, ...routing });
          for (const event of value[FOLLOW] ?? []) send(event);
        },
        (cause: unknown) =>
          send({
            id: command.id,
            error: {
              code: -32000,
              message: errorMessage(cause),
            },
            ...routing,
          }),
      );
    },
    dispose,
  };
}

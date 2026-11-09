// @effect-diagnostics nodeBuiltinImport:off - A loopback HTTP listener outside the T3 server.
/**
 * An opt-in CDP endpoint for preview tabs, on its own 127.0.0.1 listener: the T3 server also
 * answers tunnels and Tailscale Serve from loopback, so a route there could not tell local from
 * remote. A per-run token guards it from web pages and other users, not from local processes.
 */
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import {
  createExternalCdpClient,
  createExternalCdpRegistry,
  createExternalCdpTab,
  type ExternalCdpRegistry,
} from "./ExternalCdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";

export interface ExternalCdpState {
  readonly enabled: boolean;
  /** The browser-level WebSocket URL, without the token. */
  readonly endpoint: string | null;
  readonly attachedTabIds: ReadonlyArray<string>;
}

class ExternalCdpStartError extends Schema.TaggedError<ExternalCdpStartError>()(
  "ExternalCdpStartError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Couldn't start the local CDP endpoint.";
  }
}

type Check = { readonly ok: true; readonly viaQuery: boolean } | { readonly ok: false };

const sameSecret = (given: string, token: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && NodeCrypto.timingSafeEqual(a, b);
};

/**
 * The Host check stops DNS rebinding and the Origin check stops web pages. The query token is for
 * clients that take a full URL but cannot send headers, such as a DevTools frontend `ws=` link;
 * the `/json` URLs it returns carry it on.
 */
export const checkRequest = (
  request: {
    readonly host: string | undefined;
    readonly origin: string | undefined;
    readonly authorization: string | undefined;
    readonly url: URL;
  },
  port: number,
  token: string,
): Check => {
  const host = request.host?.toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return { ok: false };
  if (request.origin !== undefined && request.origin !== "null") return { ok: false };
  const bearer = /^Bearer (.+)$/i.exec(request.authorization ?? "")?.[1];
  if (bearer !== undefined)
    return sameSecret(bearer, token) ? { ok: true, viaQuery: false } : { ok: false };
  const query = request.url.searchParams.get("token");
  return query !== null && sameSecret(query, token) ? { ok: true, viaQuery: true } : { ok: false };
};

export interface ExternalCdpServer {
  readonly port: number;
  readonly browserPath: string;
  readonly close: () => Promise<void>;
}

export const startExternalCdpServer = (options: {
  readonly registry: ExternalCdpRegistry;
  readonly token: string;
  readonly product: string;
  readonly userAgent: () => string;
}): Promise<ExternalCdpServer> =>
  new Promise((resolve, reject) => {
    const browserPath = `/devtools/browser/${NodeCrypto.randomUUID()}`;
    const wss = new NodeWS.WebSocketServer({ noServer: true, perMessageDeflate: false });
    const server = NodeHttp.createServer();
    const portOf = () => {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : 0;
    };
    const authorize = (request: NodeHttp.IncomingMessage) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const check = checkRequest(
        {
          host: request.headers.host,
          origin: request.headers.origin,
          authorization: request.headers.authorization,
          url,
        },
        portOf(),
        options.token,
      );
      return { url, check };
    };
    const wsUrl = (path: string, viaQuery: boolean) =>
      `ws://127.0.0.1:${portOf()}${path}${viaQuery ? `?token=${encodeURIComponent(options.token)}` : ""}`;
    const findTab = async (targetId: string) => {
      for (const tab of options.registry.tabs()) {
        if ((await tab.targetInfo())["targetId"] === targetId) return tab;
      }
      return undefined;
    };

    server.on("request", (request, response) => {
      const respond = (status: number, body: unknown) => {
        response.writeHead(status, { "Content-Type": "application/json; charset=UTF-8" });
        response.end(JSON.stringify(body));
      };
      const { url, check } = authorize(request);
      if (!check.ok) {
        respond(403, { error: "Forbidden" });
        return;
      }
      const path = url.pathname.replace(/\/+$/, "");
      if (request.method !== "GET") {
        respond(405, { error: "T3 opens and closes tabs itself." });
        return;
      }
      if (path === "/json/version") {
        respond(200, {
          Browser: options.product,
          "Protocol-Version": "1.3",
          "User-Agent": options.userAgent(),
          "V8-Version": process.versions.v8,
          "WebKit-Version": "",
          webSocketDebuggerUrl: wsUrl(browserPath, check.viaQuery),
        });
        return;
      }
      if (path === "/json" || path === "/json/list") {
        void Promise.all(
          options.registry.tabs().map(async (tab) => {
            const info = await tab.targetInfo();
            return {
              description: "",
              id: info["targetId"],
              title: info["title"],
              type: "page",
              url: info["url"],
              webSocketDebuggerUrl: wsUrl(
                `/devtools/page/${String(info["targetId"])}`,
                check.viaQuery,
              ),
            };
          }),
        ).then(
          (list) => respond(200, list),
          () => respond(500, { error: "Couldn't list tabs." }),
        );
        return;
      }
      respond(404, { error: "Not found" });
    });

    server.on("upgrade", (request, socket, head) => {
      const refuse = (status: string) => {
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      };
      const { url, check } = authorize(request);
      if (!check.ok) {
        refuse("403 Forbidden");
        return;
      }
      const page = /^\/devtools\/page\/([^/]+)$/.exec(url.pathname)?.[1];
      if (page === undefined && url.pathname !== browserPath) {
        refuse("404 Not Found");
        return;
      }
      void (page === undefined ? Promise.resolve(undefined) : findTab(decodeURIComponent(page)))
        .then((tab) => {
          if (page !== undefined && tab === undefined) {
            refuse("404 Not Found");
            return;
          }
          wss.handleUpgrade(request, socket, head, (ws) => {
            const client = createExternalCdpClient({
              registry: options.registry,
              ...(tab ? { pageTabId: tab.id } : {}),
              product: options.product,
              userAgent: options.userAgent,
              write: (message) => ws.send(message),
              close: () => ws.close(),
            });
            ws.on("message", (data) => client.receive(String(data)));
            ws.on("close", () => client.dispose());
            ws.on("error", () => client.dispose());
          });
        })
        .catch(() => refuse("500 Internal Server Error"));
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve({
        port: portOf(),
        browserPath,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });

export class ExternalCdp extends Context.Service<
  ExternalCdp,
  {
    /** Shares a guest's debugger; a repeat for the same guest keeps what it has tracked. */
    readonly register: (
      tabId: string,
      debuggee: {
        readonly webContents: Electron.WebContents;
        readonly debugger: Electron.Debugger;
      },
    ) => void;
    readonly unregister: (webContentsId: number) => void;
    readonly state: Effect.Effect<ExternalCdpState>;
    readonly setEnabled: (
      enabled: boolean,
    ) => Effect.Effect<ExternalCdpState, ExternalCdpStartError>;
    /** The per-run bearer token; it never leaves the main process except to the clipboard. */
    readonly token: string;
    readonly disconnect: (tabId: string) => void;
    readonly subscribe: (listener: (state: ExternalCdpState) => void) => () => void;
  }
>()("@t3tools/desktop/preview/ExternalCdp") {}

const make = Effect.gen(function* () {
  const registry = createExternalCdpRegistry();
  const token = NodeCrypto.randomBytes(32).toString("base64url");
  const registered = new Map<
    string,
    {
      readonly webContents: Electron.WebContents;
      readonly debugger: Electron.Debugger;
      readonly stop: () => void;
    }
  >();
  const listeners = new Set<(state: ExternalCdpState) => void>();
  let server: ExternalCdpServer | null = null;
  let starting: Promise<ExternalCdpServer> | null = null;
  // Starts off every run; the token and port change each run, so clients are set up again anyway.
  let enabled = false;

  const snapshot = (): ExternalCdpState => ({
    enabled,
    endpoint: server ? `ws://127.0.0.1:${server.port}${server.browserPath}` : null,
    attachedTabIds: registry.attachedTabIds(),
  });
  const notify = () => {
    const state = snapshot();
    for (const listener of listeners) listener(state);
  };
  registry.onChange(notify);

  const unregisterTab = (tabId: string) => {
    const entry = registered.get(tabId);
    if (!entry) return;
    registered.delete(tabId);
    entry.stop();
    registry.remove(tabId);
  };

  const stopServer = async () => {
    const running = server ?? (await starting?.catch(() => null)) ?? null;
    server = null;
    starting = null;
    registry.disconnectAll();
    await running?.close();
  };
  yield* Effect.addFinalizer(() => Effect.promise(stopServer));

  const userAgent = () => registered.values().next().value?.webContents.getUserAgent() ?? "";
  const product = `Chrome/${process.versions.chrome ?? ""}`;

  return ExternalCdp.of({
    token,
    register: (tabId, debuggee) => {
      const existing = registered.get(tabId);
      if (
        existing?.webContents === debuggee.webContents &&
        existing.debugger === debuggee.debugger
      ) {
        return;
      }
      unregisterTab(tabId);
      const { webContents } = debuggee;
      const tab = createExternalCdpTab(tabId, {
        send: (method, params, sessionId) =>
          sendPageCommand(webContents, debuggee.debugger, method, params, sessionId),
        targetId: () =>
          debuggee.debugger
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
      });
      const onMessage = (
        _event: Electron.Event,
        method: string,
        params: unknown,
        sessionId: string,
      ) => tab.event(method, params, sessionId);
      debuggee.debugger.on("message", onMessage);
      registered.set(tabId, {
        ...debuggee,
        stop: () => debuggee.debugger.off("message", onMessage),
      });
      registry.add(tab);
    },
    unregister: (webContentsId) => {
      for (const [tabId, entry] of registered) {
        if (entry.webContents.isDestroyed() || entry.webContents.id === webContentsId) {
          unregisterTab(tabId);
        }
      }
    },
    state: Effect.sync(snapshot),
    setEnabled: Effect.fn("ExternalCdp.setEnabled")((next: boolean) =>
      Effect.tryPromise({
        try: async () => {
          enabled = next;
          if (!next) {
            await stopServer();
          } else if (!server) {
            starting ??= startExternalCdpServer({ registry, token, product, userAgent });
            const started = await starting;
            // Turned off while it started.
            if (!enabled) await started.close();
            else server = started;
          }
          notify();
          return snapshot();
        },
        catch: (cause) => {
          enabled = false;
          starting = null;
          notify();
          return new ExternalCdpStartError({ cause });
        },
      }),
    ),
    disconnect: (tabId) => registry.disconnect(tabId),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
});

export const layer = Layer.effect(ExternalCdp, make);

// @effect-diagnostics nodeBuiltinImport:off - Talks to the loopback listener as a client would.
import * as NodeWS from "@effect/platform-node/NodeWS";
import * as NodeHttp from "node:http";
import { describe, expect, it, vi } from "vite-plus/test";

import { checkRequest, startExternalCdpServer } from "./ExternalCdp.ts";
import { createExternalCdpRegistry, createExternalCdpTab } from "./ExternalCdpRelay.ts";

const TOKEN = "per-run-token";

describe("checkRequest", () => {
  const url = (query = "") => new URL(`http://127.0.0.1:9333/json/version${query}`);
  const base = {
    host: "127.0.0.1:9333",
    origin: undefined,
    authorization: `Bearer ${TOKEN}`,
    url: url(),
  };
  it.each([
    ["the bearer token", base, { ok: true, viaQuery: false }],
    ["localhost", { ...base, host: "localhost:9333" }, { ok: true, viaQuery: false }],
    ["an opaque origin", { ...base, origin: "null" }, { ok: true, viaQuery: false }],
    [
      "the query token",
      { ...base, authorization: undefined, url: url(`?token=${TOKEN}`) },
      { ok: true, viaQuery: true },
    ],
    ["no token", { ...base, authorization: undefined }, { ok: false }],
    ["a wrong token", { ...base, authorization: "Bearer nope" }, { ok: false }],
    [
      "a wrong bearer even with a good query token",
      { ...base, authorization: "Bearer nope", url: url(`?token=${TOKEN}`) },
      { ok: false },
    ],
    ["a rebinding host", { ...base, host: "evil.example:9333" }, { ok: false }],
    ["another port", { ...base, host: "127.0.0.1:9334" }, { ok: false }],
    ["a web page", { ...base, origin: "https://evil.example" }, { ok: false }],
  ])("accepts or refuses %s", (_name, request, expected) => {
    expect(checkRequest(request, 9333, TOKEN)).toEqual(expected);
  });
});

const get = (port: number, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    NodeHttp.get({ host: "127.0.0.1", port, path, headers }, (response) => {
      let data = "";
      response.on("data", (chunk) => (data += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(data) }),
      );
    }).on("error", reject);
  });

const openSocket = (url: string, headers: Record<string, string>) =>
  new Promise<NodeWS.WebSocket>((resolve, reject) => {
    const socket = new NodeWS.WebSocket(url, { headers });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

describe("external CDP listener", () => {
  it("lists only preview tabs and serves CDP to a client with the token", async () => {
    const registry = createExternalCdpRegistry();
    registry.add(
      createExternalCdpTab("tab-1", {
        send: vi.fn(async () => ({})),
        targetId: async () => "GUEST-TARGET",
        url: () => "http://localhost:4719/",
        title: () => "Fixture",
      }),
    );
    const server = await startExternalCdpServer({
      registry,
      token: TOKEN,
      product: "Chrome/146",
      userAgent: () => "UA",
    });
    try {
      const auth = { Authorization: `Bearer ${TOKEN}` };
      expect((await get(server.port, "/json/list")).status).toBe(403);
      expect(
        (await get(server.port, "/json/list", { ...auth, Origin: "https://evil.example" })).status,
      ).toBe(403);

      const list = await get(server.port, "/json/list", auth);
      expect(list).toEqual({
        status: 200,
        body: [
          expect.objectContaining({
            id: "GUEST-TARGET",
            type: "page",
            url: "http://localhost:4719/",
            webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/GUEST-TARGET`,
          }),
        ],
      });
      const version = await get(server.port, "/json/version/", auth);
      const browserUrl = (version.body as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      expect(browserUrl).toBe(`ws://127.0.0.1:${server.port}${server.browserPath}`);
      const viaQuery = await get(server.port, `/json/version?token=${TOKEN}`);
      expect((viaQuery.body as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl).toBe(
        `${browserUrl}?token=${TOKEN}`,
      );

      await expect(openSocket(browserUrl, {})).rejects.toThrow(/403/);
      const socket = await openSocket(browserUrl, auth);
      const reply = new Promise<unknown>((resolve) =>
        socket.once("message", (data) => resolve(JSON.parse(String(data)))),
      );
      socket.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
      expect(await reply).toEqual({
        id: 1,
        result: expect.objectContaining({ product: "Chrome/146", userAgent: "UA" }),
      });
      const closed = new Promise((resolve) => socket.once("close", resolve));
      await server.close();
      await closed;
    } finally {
      await server.close();
    }
  });
});

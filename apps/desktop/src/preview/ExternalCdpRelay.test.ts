import { describe, expect, it, vi } from "vite-plus/test";

import { createCdpRelayConnection } from "./CdpRelay.ts";
import {
  createExternalCdpClient,
  createExternalCdpRegistry,
  createExternalCdpTab,
  type ExternalCdpTabSource,
} from "./ExternalCdpRelay.ts";

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const setup = (send: ExternalCdpTabSource["send"] = vi.fn(async () => ({}))) => {
  const registry = createExternalCdpRegistry();
  const tab = createExternalCdpTab("tab-1", {
    send,
    targetId: async () => "GUEST-TARGET",
    url: () => "http://localhost:4719/",
    title: () => "Fixture",
  });
  registry.add(tab);
  // T3's own relay shares the same debugger messages, as DesktopBrowserHost wires it.
  const t3Written: Array<Record<string, unknown>> = [];
  const t3 = createCdpRelayConnection(
    {
      send,
      targetId: async () => "GUEST-TARGET",
      url: () => "",
      title: () => "",
      userAgent: () => "",
      setDownloadDirectory: () => {},
    },
    (raw) => t3Written.push(JSON.parse(raw)),
    () => {},
  );
  t3.receive(JSON.stringify({ id: 1, method: "Target.setAutoAttach", params: {} }));
  const debuggerMessage = (method: string, params: unknown, sessionId = "") => {
    t3.event(method, params, sessionId);
    tab.event(method, params, sessionId);
  };
  const connect = (pageTabId?: string) => {
    const written: Array<Record<string, unknown>> = [];
    const close = vi.fn();
    const client = createExternalCdpClient({
      registry,
      ...(pageTabId ? { pageTabId } : {}),
      product: "Chrome/146",
      userAgent: () => "UA",
      write: (raw) => written.push(JSON.parse(raw)),
      close,
    });
    let id = 0;
    const command = async (method: string, params: object = {}, sessionId?: string) => {
      const commandId = ++id;
      client.receive(
        JSON.stringify({ id: commandId, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
      await settle();
      return written.find((message) => message["id"] === commandId)!;
    };
    return { client, written, close, command };
  };
  /** Attaches like Playwright and Puppeteer do and returns the page session. */
  const attach = async (client: ReturnType<typeof connect>) => {
    await client.command("Target.setAutoAttach", { autoAttach: true, flatten: true });
    const attached = client.written.find((m) => m["method"] === "Target.attachedToTarget")!;
    return (attached["params"] as { sessionId: string }).sessionId;
  };
  return { registry, tab, send, t3Written, debuggerMessage, connect, attach };
};

describe("external CDP relay", () => {
  it("presents only the registered tabs, in discovery order before the reply", async () => {
    const { connect } = setup();
    const client = connect();
    await client.command("Target.setDiscoverTargets", { discover: true });
    expect(client.written.map((m) => m["method"] ?? `reply ${String(m["id"])}`)).toEqual([
      "Target.targetCreated",
      "reply 1",
    ]);
    const targets = await client.command("Target.getTargets");
    expect(targets["result"]).toEqual({
      targetInfos: [expect.objectContaining({ targetId: "GUEST-TARGET", type: "page" })],
    });
    await client.command("Target.setAutoAttach", { autoAttach: true, flatten: true });
    expect(client.written.at(-1)).toEqual({
      method: "Target.attachedToTarget",
      params: expect.objectContaining({
        sessionId: expect.any(String),
        targetInfo: expect.objectContaining({ targetId: "GUEST-TARGET" }),
        waitingForDebugger: false,
      }),
    });
  });

  it("refuses what would close T3's tab, intercept its requests, or take its screencast", async () => {
    const { connect, attach, send } = setup();
    const client = connect();
    const page = await attach(client);
    for (const [method, sessionId] of [
      ["Browser.close", undefined],
      ["Target.createTarget", undefined],
      ["Target.closeTarget", undefined],
      ["Page.close", page],
      ["Fetch.enable", page],
      ["Page.startScreencast", page],
      ["Target.detachFromTarget", page],
    ] as const) {
      const reply = await client.command(method, {}, sessionId);
      if (method === "Target.detachFromTarget") expect(reply).toHaveProperty("result");
      else expect(reply).toHaveProperty("error");
    }
    expect(send).not.toHaveBeenCalled();
  });

  it("fans page events out to each client listening on that domain, and to T3", async () => {
    const { connect, attach, debuggerMessage, t3Written } = setup();
    const first = connect();
    const second = connect();
    const firstPage = await attach(first);
    const secondPage = await attach(second);
    await first.command("Page.enable", {}, firstPage);
    await second.command("Network.enable", {}, secondPage);
    first.written.length = 0;
    second.written.length = 0;
    t3Written.length = 0;

    debuggerMessage("Page.loadEventFired", { timestamp: 1 });
    debuggerMessage("Network.requestWillBeSent", { requestId: "r1" });

    expect(first.written).toEqual([
      { method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: firstPage },
    ]);
    expect(second.written).toEqual([
      { method: "Network.requestWillBeSent", params: { requestId: "r1" }, sessionId: secondPage },
    ]);
    expect(t3Written.map((m) => m["method"])).toEqual([
      "Page.loadEventFired",
      "Network.requestWillBeSent",
    ]);
  });

  // Runtime.enable on a debugger T3 already enabled reports no existing contexts.
  it("replays the page's live execution contexts to a client that enables Runtime", async () => {
    const { connect, attach, debuggerMessage, send } = setup();
    debuggerMessage("Runtime.executionContextCreated", { context: { id: 1, name: "" } });
    debuggerMessage("Runtime.executionContextCreated", { context: { id: 2, name: "gone" } });
    debuggerMessage("Runtime.executionContextDestroyed", { executionContextId: 2 });
    debuggerMessage("Runtime.executionContextCreated", { context: { id: 3, name: "x" } }, "frame");

    for (const client of [connect(), connect()]) {
      const page = await attach(client);
      client.written.length = 0;
      await client.command("Runtime.enable", {}, page);
      expect(client.written).toEqual([
        {
          method: "Runtime.executionContextCreated",
          params: { context: { id: 1, name: "" } },
          sessionId: page,
        },
        { id: expect.any(Number), result: {}, sessionId: page },
      ]);
    }
    expect(send).toHaveBeenCalledWith("Runtime.enable", {}, undefined);
  });

  it("replays frames T3 already auto-attached and never leaves new frames paused", async () => {
    const { connect, attach, debuggerMessage, send } = setup();
    debuggerMessage("Target.attachedToTarget", {
      sessionId: "FRAME",
      targetInfo: { targetId: "IFRAME", type: "iframe" },
      waitingForDebugger: true,
    });
    const client = connect();
    const page = await attach(client);
    client.written.length = 0;
    await client.command(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      page,
    );
    expect(send).toHaveBeenCalledWith(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      undefined,
    );
    expect(client.written[0]).toEqual({
      method: "Target.attachedToTarget",
      params: expect.objectContaining({ sessionId: "FRAME", waitingForDebugger: false }),
      sessionId: page,
    });
    await client.command("DOM.enable", {}, "FRAME");
    expect(send).toHaveBeenLastCalledWith("DOM.enable", {}, "FRAME");
    client.written.length = 0;
    debuggerMessage("DOM.documentUpdated", {}, "FRAME");
    expect(client.written).toEqual([
      { method: "DOM.documentUpdated", params: {}, sessionId: "FRAME" },
    ]);
  });

  it("keeps one client's disable and disconnect off the shared debugger", async () => {
    let script = 0;
    const send = vi.fn(async (method: string) =>
      method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: `s${++script}` } : {},
    );
    const { connect, attach, debuggerMessage, registry } = setup(send);
    const leaving = connect();
    const staying = connect();
    const leavingPage = await attach(leaving);
    const stayingPage = await attach(staying);
    for (const [client, page] of [
      [leaving, leavingPage],
      [staying, stayingPage],
    ] as const) {
      await client.command("Runtime.enable", {}, page);
      await client.command("Page.addScriptToEvaluateOnNewDocument", { source: "" }, page);
    }
    await leaving.command("Debugger.enable", {}, leavingPage);
    await leaving.command("Runtime.disable", {}, leavingPage);
    expect(registry.attachedTabIds()).toEqual(["tab-1"]);
    send.mockClear();

    leaving.client.dispose();

    expect(send.mock.calls).toEqual([
      ["Page.removeScriptToEvaluateOnNewDocument", { identifier: "s1" }, undefined],
      ["Debugger.resume", {}, undefined],
    ]);
    leaving.written.length = 0;
    staying.written.length = 0;
    debuggerMessage("Runtime.consoleAPICalled", { type: "log" });
    expect(leaving.written).toEqual([]);
    expect(staying.written).toEqual([
      { method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: stayingPage },
    ]);
    expect(registry.attachedTabIds()).toEqual(["tab-1"]);
  });

  it("drives a tab through its page endpoint and disconnects on request", async () => {
    const { connect, debuggerMessage, registry, send } = setup();
    const changes = vi.fn();
    registry.onChange(changes);
    const client = connect("tab-1");
    expect(registry.attachedTabIds()).toEqual(["tab-1"]);
    await client.command("Page.navigate", { url: "https://example.com" });
    expect(send).toHaveBeenLastCalledWith(
      "Page.navigate",
      { url: "https://example.com" },
      undefined,
    );
    client.written.length = 0;
    debuggerMessage("Page.frameNavigated", { frame: {} });
    expect(client.written).toEqual([{ method: "Page.frameNavigated", params: { frame: {} } }]);

    registry.disconnect("tab-1");

    expect(client.close).toHaveBeenCalledOnce();
    expect(registry.attachedTabIds()).toEqual([]);
    expect(changes).toHaveBeenCalled();
  });

  it("detaches a closed tab from browser clients and closes its page clients", async () => {
    const { connect, attach, registry } = setup();
    const browser = connect();
    await browser.command("Target.setDiscoverTargets", { discover: true });
    const page = await attach(browser);
    const pageClient = connect("tab-1");

    registry.remove("tab-1");
    await settle();

    expect(pageClient.close).toHaveBeenCalledOnce();
    expect(browser.close).not.toHaveBeenCalled();
    expect(browser.written.slice(-2)).toEqual([
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: page, targetId: "GUEST-TARGET" },
      },
      { method: "Target.targetDestroyed", params: { targetId: "GUEST-TARGET" } },
    ]);
    expect(await browser.command("DOM.enable", {}, page)).toHaveProperty("error");
  });
});

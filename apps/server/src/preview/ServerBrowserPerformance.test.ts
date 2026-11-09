// @effect-diagnostics nodeBuiltinImport:off - The service under test writes traces with node:fs outside the Effect runtime.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { CDPSession, Page } from "playwright-core";
import { describe, expect, it } from "vite-plus/test";

import * as ServerBrowserPerformance from "./ServerBrowserPerformance.ts";

const TRACE = JSON.stringify({
  traceEvents: [
    {
      name: "navigationStart",
      ts: 1_000_000,
      args: { frame: "F", data: { navigationId: "N", isOutermostMainFrame: true } },
    },
    {
      name: "largestContentfulPaint::Candidate",
      ts: 1_250_000,
      args: { frame: "F", data: { navigationId: "N", isOutermostMainFrame: true } },
    },
    { name: "LayoutShift", ts: 1_300_000, args: { data: { weighted_score_delta: 0.05 } } },
    { name: "LayoutShift", ts: 1_400_000, args: { data: { weighted_score_delta: 0.07 } } },
    // Input-driven shifts do not count.
    {
      name: "LayoutShift",
      ts: 1_500_000,
      args: { data: { weighted_score_delta: 0.5, had_recent_input: true } },
    },
    // A new window after a gap over 1 s.
    { name: "LayoutShift", ts: 4_000_000, args: { data: { weighted_score_delta: 0.1 } } },
  ],
});

/** A CDP session that answers like Chromium and records what it was sent. */
const fakeSession = (options: { trace?: string; startError?: string } = {}) => {
  const emitter = new NodeEvents.EventEmitter();
  const sent: Array<string> = [];
  const trace = Buffer.from(options.trace ?? TRACE);
  let offset = 0;
  let metricsReads = 0;
  let detached = false;
  const send = async (method: string, params?: { size?: number }) => {
    sent.push(method);
    switch (method) {
      case "Tracing.start":
        if (options.startError) throw new Error(options.startError);
        return {};
      case "Performance.getMetrics": {
        const scale = metricsReads++ === 0 ? 1 : 2;
        return {
          metrics: [
            { name: "TaskDuration", value: 0.1 * scale },
            { name: "ScriptDuration", value: 0.04 * scale },
            { name: "LayoutDuration", value: 0.01 * scale },
            { name: "JSHeapUsedSize", value: 1000 * scale },
            { name: "Nodes", value: 50 * scale },
          ],
        };
      }
      case "Tracing.end":
        queueMicrotask(() =>
          emitter.emit("Tracing.tracingComplete", { stream: "stream-1", dataLossOccurred: false }),
        );
        return {};
      case "IO.read": {
        const chunk = trace.subarray(offset, offset + Math.min(params?.size ?? 64, 64));
        offset += chunk.byteLength;
        // Chromium may send any chunk as base64.
        const base64Encoded = offset % 2 === 0;
        return {
          data: chunk.toString(base64Encoded ? "base64" : "utf8"),
          base64Encoded,
          eof: offset >= trace.byteLength,
        };
      }
      default:
        return {};
    }
  };
  const session = Object.assign(emitter, {
    send,
    detach: async () => {
      detached = true;
      emitter.emit("close");
    },
  });
  return {
    session: session as unknown as CDPSession,
    sent,
    detached: () => detached,
  };
};

const setup = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-perf-"));
  const page = new NodeEvents.EventEmitter() as unknown as Page;
  const sessions: Array<ReturnType<typeof fakeSession>> = [];
  let clock = 1_000;
  const tab = (options?: Parameters<typeof fakeSession>[0]) => ({
    tabId: "tab-1",
    threadId: "thread-1",
    page,
    openSession: async () => {
      const created = fakeSession(options);
      sessions.push(created);
      return created.session;
    },
  });
  const output = (maxBytes?: number) => ({
    directory,
    now: () => (clock += 500),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return {
    directory,
    page,
    sessions,
    tab,
    output,
    [Symbol.asyncDispose]: () => NodeFSP.rm(directory, { recursive: true, force: true }),
  };
};

describe("ServerBrowserPerformance", () => {
  it("records a trace, saves it to the thread's attachments, and returns metrics", async () => {
    await using env = await setup();
    const tab = env.tab();

    const started = await ServerBrowserPerformance.performance(
      tab,
      { action: "start" },
      env.output(),
    );
    expect(started).toEqual({ tabId: "tab-1", tracing: true, startedAt: expect.any(String) });
    const stopped = await ServerBrowserPerformance.performance(
      tab,
      { action: "stop" },
      env.output(),
    );

    const [session] = env.sessions;
    expect(session?.sent).toEqual([
      "Performance.enable",
      "Performance.getMetrics",
      "Tracing.start",
      "Performance.getMetrics",
      "Tracing.end",
      ...Array(Math.ceil(TRACE.length / 64)).fill("IO.read"),
      "IO.close",
      "Performance.disable",
    ]);
    expect(session?.detached()).toBe(true);
    expect(stopped).toEqual({
      tabId: "tab-1",
      tracing: false,
      startedAt: started.startedAt,
      durationMs: 500,
      path: expect.stringMatching(/^.*\/thread-1-[0-9a-f-]+-json\.json$/),
      sizeBytes: TRACE.length,
      metrics: {
        taskMs: 100,
        scriptMs: 40,
        layoutMs: 10,
        jsHeapUsedBytes: 2000,
        nodes: 100,
        largestContentfulPaintMs: 250,
        cumulativeLayoutShift: 0.12,
      },
    });
    expect(NodePath.dirname(stopped.path!)).toBe(env.directory);
    expect(await NodeFSP.readFile(stopped.path!, "utf8")).toBe(TRACE);
  });

  it("allows one trace per tab and reports a trace another tab holds", async () => {
    await using env = await setup();
    await ServerBrowserPerformance.performance(env.tab(), { action: "start" }, env.output());

    await expect(
      ServerBrowserPerformance.performance(env.tab(), { action: "start" }, env.output()),
    ).rejects.toMatchObject({ tag: "PreviewAutomationPerformanceTraceActiveError" });
    expect(env.sessions).toHaveLength(1);

    const otherTab = {
      ...env.tab({ startError: "Tracing has already been started (possibly in another tab)." }),
      page: new NodeEvents.EventEmitter() as unknown as Page,
    };
    await expect(
      ServerBrowserPerformance.performance(otherTab, { action: "start" }, env.output()),
    ).rejects.toMatchObject({
      tag: "PreviewAutomationPerformanceTraceActiveError",
      message: expect.stringContaining("in this browser"),
    });
    expect(env.sessions[1]?.detached()).toBe(true);
    await expect(
      ServerBrowserPerformance.performance(otherTab, { action: "stop" }, env.output()),
    ).rejects.toMatchObject({ tag: "PreviewAutomationPerformanceTraceNotActiveError" });
  });

  it("discards a trace over the size cap and ends tracing", async () => {
    await using env = await setup();
    const tab = env.tab();
    await ServerBrowserPerformance.performance(tab, { action: "start" }, env.output());

    await expect(
      ServerBrowserPerformance.performance(tab, { action: "stop" }, env.output(100)),
    ).rejects.toMatchObject({ tag: "PreviewAutomationPerformanceTraceTooLargeError" });
    expect(env.sessions[0]?.sent).toContain("IO.close");
    expect(env.sessions[0]?.detached()).toBe(true);
    expect(await NodeFSP.readdir(env.directory)).toEqual([]);
    await expect(
      ServerBrowserPerformance.performance(tab, { action: "stop" }, env.output()),
    ).rejects.toMatchObject({ tag: "PreviewAutomationPerformanceTraceNotActiveError" });
  });

  it("ends the trace when the tab closes", async () => {
    await using env = await setup();
    const tab = env.tab();
    await ServerBrowserPerformance.performance(tab, { action: "start" }, env.output());

    (env.page as unknown as NodeEvents.EventEmitter).emit("close");

    expect(env.sessions[0]?.detached()).toBe(true);
    await expect(
      ServerBrowserPerformance.performance(tab, { action: "stop" }, env.output()),
    ).rejects.toMatchObject({ tag: "PreviewAutomationPerformanceTraceNotActiveError" });
    // The tab is free to trace again.
    await ServerBrowserPerformance.performance(tab, { action: "start" }, env.output());
    expect(env.sessions).toHaveLength(2);
  });
});

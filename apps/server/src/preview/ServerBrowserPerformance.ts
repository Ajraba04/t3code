// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Playwright callbacks run outside the Effect runtime.
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PreviewTabId,
  type PreviewAutomationPerformanceInput,
  type PreviewAutomationPerformanceMetrics,
  type PreviewAutomationPerformanceResult,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { constVoid } from "effect/Function";
import type { CDPSession, Page } from "playwright-core";

import { createAttachmentId } from "../attachmentStore.ts";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

/** What DevTools' Performance panel records, without screenshots. */
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "loading",
  "v8.execute",
  "blink.user_timing",
];
const READ_CHUNK_BYTES = 1024 * 1024;
/** Parsing blocks the server, so larger traces return the file without web vitals. */
const VITALS_PARSE_BYTES = 16 * 1024 * 1024;

export interface TraceTab {
  readonly tabId: string;
  readonly threadId: string;
  readonly page: Page;
  /** A session of its own, so detaching it ends the trace without touching the tab's session. */
  readonly openSession: () => Promise<CDPSession>;
}

export interface TraceOutput {
  readonly directory: string;
  readonly maxBytes?: number;
  readonly now?: () => number;
}

interface ActiveTrace {
  readonly session: CDPSession;
  readonly startedAt: number;
  readonly baseline: ReadonlyMap<string, number>;
  readonly release: () => void;
}

// Keyed by page so a trace dies with its tab without the tab holding trace state.
const traces = new WeakMap<Page, Promise<ActiveTrace>>();

const operationError = (tag: string, message: string, cause?: unknown) =>
  new ServerBrowserOperationError({
    tag,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

const readMetrics = async (session: CDPSession) => {
  const { metrics } = await session.send("Performance.getMetrics");
  return new Map(metrics.map(({ name, value }) => [name, value]));
};

const startTrace = async (tab: TraceTab, now: () => number) => {
  if (traces.has(tab.page))
    throw operationError(
      "PreviewAutomationPerformanceTraceActiveError",
      "A performance trace is already running on this tab. Stop it first.",
    );
  const starting = (async (): Promise<ActiveTrace> => {
    const session = await tab.openSession();
    try {
      await session.send("Performance.enable", {});
      const baseline = await readMetrics(session);
      await session
        .send("Tracing.start", {
          transferMode: "ReturnAsStream",
          streamFormat: "json",
          streamCompression: "none",
          traceConfig: {
            recordMode: "recordUntilFull",
            includedCategories: TRACE_CATEGORIES,
          },
        })
        .catch((cause: unknown) => {
          // Chromium runs one trace at a time per browser.
          throw /already/i.test(cause instanceof Error ? cause.message : String(cause))
            ? operationError(
                "PreviewAutomationPerformanceTraceActiveError",
                "Another performance trace is running in this browser. Stop it, then start again.",
                cause,
              )
            : cause;
        });
      // A closed tab or a lost session ends the trace; detaching stops Chromium's recording.
      const release = () => {
        tab.page.off("close", abandon);
        session.off("close", abandon);
      };
      const abandon = () => {
        if (traces.get(tab.page) !== starting) return;
        traces.delete(tab.page);
        release();
        void session.detach().catch(constVoid);
      };
      tab.page.once("close", abandon);
      session.once("close", abandon);
      return { session, startedAt: now(), baseline, release };
    } catch (cause) {
      await session.detach().catch(constVoid);
      throw cause;
    }
  })();
  traces.set(tab.page, starting);
  try {
    const trace = await starting;
    return {
      tabId: PreviewTabId.make(tab.tabId),
      tracing: true,
      startedAt: new Date(trace.startedAt).toISOString(),
    } satisfies PreviewAutomationPerformanceResult;
  } catch (cause) {
    if (traces.get(tab.page) === starting) traces.delete(tab.page);
    throw cause;
  }
};

const collectStream = async (session: CDPSession, handle: string, maxBytes: number) => {
  const chunks: Array<Buffer> = [];
  let size = 0;
  try {
    for (;;) {
      const read = await session.send("IO.read", { handle, size: READ_CHUNK_BYTES });
      const chunk = Buffer.from(read.data, read.base64Encoded ? "base64" : "utf8");
      size += chunk.byteLength;
      if (size > maxBytes)
        throw operationError(
          "PreviewAutomationPerformanceTraceTooLargeError",
          `The trace passed ${Math.floor(maxBytes / (1024 * 1024))} MiB and was discarded. Trace a shorter interaction.`,
        );
      chunks.push(chunk);
      if (read.eof) break;
    }
  } finally {
    await session.send("IO.close", { handle }).catch(constVoid);
  }
  return Buffer.concat(chunks);
};

const endTrace = (session: CDPSession) =>
  new Promise<{ stream?: string; dataLossOccurred: boolean }>((resolve, reject) => {
    const onClose = () => reject(new Error("The tab closed before the trace finished."));
    session.once("close", onClose);
    session.once("Tracing.tracingComplete", (complete) => {
      session.off("close", onClose);
      resolve(complete);
    });
    session.send("Tracing.end").catch((cause: unknown) => {
      session.off("close", onClose);
      reject(cause);
    });
  });

const round = (value: number, digits = 0) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

/** Durations are cumulative seconds in Performance.getMetrics, so the trace's share is the difference. */
const DURATION_METRICS = [
  ["TaskDuration", "taskMs"],
  ["ScriptDuration", "scriptMs"],
  ["LayoutDuration", "layoutMs"],
] as const;
const CURRENT_METRICS = [
  ["JSHeapUsedSize", "jsHeapUsedBytes"],
  ["Nodes", "nodes"],
] as const;

const metricsDelta = (
  baseline: ReadonlyMap<string, number>,
  final: ReadonlyMap<string, number>,
): PreviewAutomationPerformanceMetrics => {
  const metrics: { -readonly [K in keyof PreviewAutomationPerformanceMetrics]?: number } = {};
  for (const [name, field] of DURATION_METRICS) {
    const end = final.get(name);
    if (end !== undefined) metrics[field] = round((end - (baseline.get(name) ?? 0)) * 1000, 1);
  }
  for (const [name, field] of CURRENT_METRICS) {
    const value = final.get(name);
    if (value !== undefined) metrics[field] = value;
  }
  return metrics;
};

interface TraceEvent {
  readonly name?: string;
  readonly ts?: number;
  readonly args?: {
    readonly frame?: string;
    readonly data?: {
      readonly navigationId?: string;
      readonly isOutermostMainFrame?: boolean;
      readonly isMainFrame?: boolean;
      readonly had_recent_input?: boolean;
      readonly weighted_score_delta?: number;
      readonly score?: number;
    };
  };
}

const isMainFrame = (event: TraceEvent) =>
  event.args?.data?.isOutermostMainFrame ?? event.args?.data?.isMainFrame ?? true;

/** LCP of the last main-frame navigation in the trace, and CLS as the largest session window. */
const webVitals = (events: ReadonlyArray<TraceEvent>): PreviewAutomationPerformanceMetrics => {
  const timed = events
    .filter((event): event is TraceEvent & { ts: number } => typeof event.ts === "number")
    .toSorted((left, right) => left.ts - right.ts);
  const navigations = timed.filter(
    (event) => event.name === "navigationStart" && isMainFrame(event),
  );
  const candidate = timed.findLast(
    (event) => event.name === "largestContentfulPaint::Candidate" && isMainFrame(event),
  );
  const navigation =
    candidate === undefined
      ? undefined
      : (navigations.findLast(
          (event) =>
            candidate.args?.data?.navigationId !== undefined &&
            event.args?.data?.navigationId === candidate.args.data.navigationId,
        ) ??
        navigations.findLast(
          (event) => event.ts <= candidate.ts && event.args?.frame === candidate.args?.frame,
        ));

  let cls = 0;
  let windowScore = 0;
  let windowStart = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const event of timed) {
    if (event.name !== "LayoutShift" || event.args?.data?.had_recent_input) continue;
    const score = event.args?.data?.weighted_score_delta ?? event.args?.data?.score ?? 0;
    // A window ends after a 1 s gap or once it spans 5 s (web.dev CLS definition).
    if (event.ts - previous > 1_000_000 || event.ts - windowStart > 5_000_000) {
      windowScore = 0;
      windowStart = event.ts;
    }
    windowScore += score;
    previous = event.ts;
    cls = Math.max(cls, windowScore);
  }
  return {
    ...(candidate && navigation
      ? { largestContentfulPaintMs: round((candidate.ts - navigation.ts) / 1000, 1) }
      : {}),
    cumulativeLayoutShift: round(cls, 4),
  };
};

const parseVitals = (trace: Buffer): PreviewAutomationPerformanceMetrics => {
  if (trace.byteLength > VITALS_PARSE_BYTES) return {};
  try {
    const parsed: unknown = JSON.parse(trace.toString("utf8"));
    const events = Array.isArray(parsed)
      ? parsed
      : (parsed as { traceEvents?: unknown } | null)?.traceEvents;
    return Array.isArray(events) ? webVitals(events as ReadonlyArray<TraceEvent>) : {};
  } catch {
    return {};
  }
};

const stopTrace = async (tab: TraceTab, output: TraceOutput, now: () => number) => {
  const pending = traces.get(tab.page);
  if (!pending)
    throw operationError(
      "PreviewAutomationPerformanceTraceNotActiveError",
      "No performance trace is running on this tab. Start one first.",
    );
  const trace = await pending;
  // A stop cannot run twice, and a failed one must not leave Chromium recording.
  traces.delete(tab.page);
  trace.release();
  const { session } = trace;
  try {
    const final = await readMetrics(session);
    const stoppedAt = now();
    const complete = await endTrace(session);
    if (!complete.stream)
      throw operationError(
        "PreviewAutomationExecutionError",
        "The browser returned no trace stream.",
      );
    const data = await collectStream(
      session,
      complete.stream,
      output.maxBytes ?? PROVIDER_SEND_TURN_MAX_FILE_BYTES,
    );
    const id = createAttachmentId(tab.threadId, "json");
    if (!id)
      throw operationError(
        "PreviewAutomationExecutionError",
        "This thread cannot store a trace file.",
      );
    const path = NodePath.join(output.directory, `${id}.json`);
    await NodeFSP.mkdir(output.directory, { recursive: true });
    await NodeFSP.writeFile(path, data);
    return {
      tabId: PreviewTabId.make(tab.tabId),
      tracing: false,
      startedAt: new Date(trace.startedAt).toISOString(),
      durationMs: Math.max(0, Math.round(stoppedAt - trace.startedAt)),
      path,
      sizeBytes: data.byteLength,
      ...(complete.dataLossOccurred ? { dataLoss: true } : {}),
      metrics: { ...metricsDelta(trace.baseline, final), ...parseVitals(data) },
    } satisfies PreviewAutomationPerformanceResult;
  } finally {
    await session.send("Performance.disable").catch(constVoid);
    await session.detach().catch(constVoid);
  }
};

export const performance = (
  tab: TraceTab,
  input: PreviewAutomationPerformanceInput,
  output: TraceOutput,
): Promise<PreviewAutomationPerformanceResult> => {
  const now = output.now ?? Date.now;
  return input.action === "start" ? startTrace(tab, now) : stopTrace(tab, output, now);
};

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { headers } from "next/headers";

import {
  PS_REQ_ID_HEADER,
  PS_REQ_METHOD_HEADER,
  PS_REQ_PATH_HEADER,
  PS_REQ_START_MS_HEADER,
} from "@/app/lib/request-timing-headers";
import { applySensitiveNoCacheHeaders } from "@/app/lib/security-headers";

type TimingSource = "api" | "page";

type RequestTimingContext = {
  requestId: string;
  method: string;
  path: string;
  startMs: number;
  handlerStartMs: number;
  dbWallMs: number;
  dbQuerySumMs: number;
  dbActiveCount: number;
  dbActiveStartedAt: number | null;
  handlerMs: number;
  status: number;
  source: TimingSource;
};

type RequestTimingMeta = {
  requestId: string;
  method: string;
  path: string;
  startMs: number;
  source: TimingSource;
  shouldLog: boolean;
};

const timingStorage = new AsyncLocalStorage<RequestTimingContext>();
const LOG_PREFIX = "[PERF] [WEBAPP]";

function nowMs() {
  return Date.now();
}

function parseStartMs(value: string | null) {
  if (!value) return nowMs();
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return nowMs();
  return parsed;
}

function parsePath(path: string | null | undefined, fallback: string) {
  if (!path) return fallback;
  const queryIndex = path.indexOf("?");
  if (queryIndex >= 0) {
    return path.slice(0, queryIndex) || fallback;
  }
  return path || fallback;
}

function ms(value: number) {
  return Math.max(0, Math.round(value));
}

function statusFromError(err: unknown) {
  if (err && typeof err === "object" && "digest" in err) {
    const digest = String((err as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) {
      const parts = digest.split(";");
      const maybeStatus = Number(parts[parts.length - 2]);
      if (Number.isFinite(maybeStatus) && maybeStatus >= 300 && maybeStatus < 400) {
        return maybeStatus;
      }
      return 307;
    }
    if (digest.includes("404")) {
      return 404;
    }
  }
  return 500;
}

function createContext(meta: RequestTimingMeta): RequestTimingContext {
  return {
    requestId: meta.requestId,
    method: meta.method,
    path: meta.path,
    startMs: meta.startMs,
    handlerStartMs: meta.startMs,
    dbWallMs: 0,
    dbQuerySumMs: 0,
    dbActiveCount: 0,
    dbActiveStartedAt: null,
    handlerMs: 0,
    status: 200,
    source: meta.source,
  };
}

function finalizeDbWallMs(context: RequestTimingContext, endedAt: number) {
  if (context.dbActiveCount > 0 && context.dbActiveStartedAt !== null) {
    return context.dbWallMs + Math.max(0, endedAt - context.dbActiveStartedAt);
  }
  return context.dbWallMs;
}

function formatHandlerDoneLog(context: RequestTimingContext, endedAt: number) {
  const requestMs = ms(endedAt - context.startMs);
  const handlerMs = ms(context.handlerMs);
  const preHandlerMs = ms(context.handlerStartMs - context.startMs);
  const dbWallMs = ms(finalizeDbWallMs(context, endedAt));
  const dbQuerySumMs = ms(context.dbQuerySumMs);
  const handlerNonDbMs = ms(handlerMs - dbWallMs);

  // Field meanings:
  // - request_ms: complete request wall time from middleware entry to response log
  // - pre_handler_ms: wall time before the wrapped handler began
  // - handler_ms: wall time spent inside the wrapped page/API handler
  // - db_wall_ms: merged wall-clock time with at least one DB query in flight
  // - db_query_sum_ms: additive sum of individual query durations and may exceed wall time
  // - handler_non_db_ms: handler wall time not spent waiting on Postgres
  return (
    `${LOG_PREFIX} done req_id=${context.requestId} source=${context.source} ` +
    `method=${context.method} path=${context.path} status=${context.status} ` +
    `request_ms=${requestMs} handler_ms=${handlerMs} pre_handler_ms=${preHandlerMs} ` +
    `db_wall_ms=${dbWallMs} db_query_sum_ms=${dbQuerySumMs} handler_non_db_ms=${handlerNonDbMs}`
  );
}

function logDone(context: RequestTimingContext) {
  console.log(formatHandlerDoneLog(context, nowMs()));
}

export function beginDbTiming() {
  const context = timingStorage.getStore();
  const startedAt = nowMs();

  if (context) {
    if (context.dbActiveCount === 0) {
      context.dbActiveStartedAt = startedAt;
    }
    context.dbActiveCount += 1;
  }

  return function endDbTiming() {
    const endedAt = nowMs();
    const durationMs = Math.max(0, endedAt - startedAt);
    if (!context) return;

    context.dbQuerySumMs += durationMs;
    if (context.dbActiveCount > 0) {
      context.dbActiveCount -= 1;
    }
    if (context.dbActiveCount === 0 && context.dbActiveStartedAt !== null) {
      context.dbWallMs += Math.max(0, endedAt - context.dbActiveStartedAt);
      context.dbActiveStartedAt = null;
    }
  };
}

export function formatMiddlewareDoneLog(
  timing: {
    requestId: string;
    method: string;
    path: string;
    startMs: number;
  },
  status: number,
  endedAt = nowMs(),
) {
  const requestMs = ms(endedAt - timing.startMs);
  return (
    `${LOG_PREFIX} done req_id=${timing.requestId} source=app ` +
    `method=${timing.method} path=${timing.path} status=${status} ` +
    `request_ms=${requestMs} middleware_ms=${requestMs} db_wall_ms=0 db_query_sum_ms=0`
  );
}

function readMetaFromHeaders(rawHeaders: { get(name: string): string | null }, routeLabel: string, source: TimingSource) {
  const forwardedRequestId = rawHeaders.get(PS_REQ_ID_HEADER);
  const hasForwardedContext = Boolean(forwardedRequestId && rawHeaders.get(PS_REQ_START_MS_HEADER));
  return {
    requestId: forwardedRequestId || randomUUID(),
    method: (rawHeaders.get(PS_REQ_METHOD_HEADER) || "GET").toUpperCase(),
    path: parsePath(rawHeaders.get(PS_REQ_PATH_HEADER), routeLabel),
    startMs: parseStartMs(rawHeaders.get(PS_REQ_START_MS_HEADER)),
    source,
    shouldLog: source === "api" || hasForwardedContext,
  };
}

async function readMetaForPage(routeLabel: string) {
  try {
    const headerStore = await headers();
    return readMetaFromHeaders(headerStore, routeLabel, "page");
  } catch {
    return {
      requestId: randomUUID(),
      method: "GET",
      path: routeLabel,
      startMs: nowMs(),
      source: "page" as const,
      shouldLog: false,
    };
  }
}

async function readMetaForApi(routeLabel: string, req: unknown) {
  if (req && typeof req === "object" && "headers" in req && "method" in req) {
    const request = req as { headers?: Headers; method?: string; url?: string };
    const meta = request.headers ? readMetaFromHeaders(request.headers, routeLabel, "api") : null;
    const method = (meta?.method || request.method || "GET").toUpperCase();
    const path = meta?.path || parsePath(request.url ? new URL(request.url).pathname : null, routeLabel);
    return {
      requestId: meta?.requestId || randomUUID(),
      method,
      path,
      startMs: meta?.startMs || nowMs(),
      source: "api" as const,
      shouldLog: true,
    };
  }

  try {
    const headerStore = await headers();
    return readMetaFromHeaders(headerStore, routeLabel, "api");
  } catch {
    // no-op: use fallback metadata
  }

  return {
    requestId: randomUUID(),
    method: "GET",
    path: routeLabel,
    startMs: nowMs(),
    source: "api" as const,
    shouldLog: true,
  };
}

export function withApiRequestTiming<T extends (...args: any[]) => any>(routeLabel: string, handler: T): T {
  const wrapped = (async (...args: Parameters<T>) => {
    const meta = await readMetaForApi(routeLabel, args[0]);
    if (!meta.shouldLog) {
      return handler(...args);
    }
    const context = createContext(meta);
    const handlerStart = nowMs();
    context.handlerStartMs = handlerStart;

    return timingStorage.run(context, async () => {
      try {
        const result = await handler(...args);
        const finalResult = result instanceof Response ? applySensitiveNoCacheHeaders(result) : result;
        context.handlerMs = nowMs() - handlerStart;
        context.status = finalResult instanceof Response ? finalResult.status : 200;
        logDone(context);
        return finalResult;
      } catch (err) {
        context.handlerMs = nowMs() - handlerStart;
        context.status = statusFromError(err);
        logDone(context);
        throw err;
      }
    });
  }) as T;

  return wrapped;
}

export function withPageRequestTiming<TProps>(routeLabel: string, pageHandler: (props: TProps) => any | Promise<any>) {
  return async function timedPageHandler(props: TProps) {
    const meta = await readMetaForPage(routeLabel);
    if (!meta.shouldLog) {
      return pageHandler(props);
    }
    const context = createContext(meta);
    const handlerStart = nowMs();
    context.handlerStartMs = handlerStart;

    return timingStorage.run(context, async () => {
      try {
        const result = await pageHandler(props);
        context.handlerMs = nowMs() - handlerStart;
        context.status = 200;
        logDone(context);
        return result;
      } catch (err) {
        context.handlerMs = nowMs() - handlerStart;
        context.status = statusFromError(err);
        logDone(context);
        throw err;
      }
    });
  };
}

export const __requestTimingTestUtils = {
  createContext,
  formatHandlerDoneLog,
  withTimingContext<T>(context: RequestTimingContext, fn: () => T) {
    return timingStorage.run(context, fn);
  },
};

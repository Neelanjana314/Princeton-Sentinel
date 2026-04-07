import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

const Module = require("node:module");
const testGlobals = globalThis as typeof globalThis & {
  __psTmpAliasRegistered?: boolean;
};
if (!testGlobals.__psTmpAliasRegistered) {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown) {
    if (request.startsWith("@/")) {
      const mapped = path.join(process.cwd(), ".tmp-tests", request.slice(2));
      return originalResolveFilename.call(this, mapped, parent, isMain, options);
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  testGlobals.__psTmpAliasRegistered = true;
}

const {
  __requestTimingTestUtils,
  beginDbTiming,
  formatMiddlewareDoneLog,
} = require("../app/lib/request-timing") as typeof import("../app/lib/request-timing");

function withFakeNow<T>(fn: (setNow: (value: number) => void) => T): T {
  const originalNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    return fn((value) => {
      now = value;
    });
  } finally {
    Date.now = originalNow;
  }
}

function parseLogFields(line: string) {
  const fields: Record<string, string> = {};
  for (const part of line.split(" ")) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex <= 0) continue;
    fields[part.slice(0, equalsIndex)] = part.slice(equalsIndex + 1);
  }
  return fields;
}

function createContext(startMs: number, handlerStartMs: number, handlerMs: number, status = 200) {
  const context = __requestTimingTestUtils.createContext({
    requestId: "req-1",
    method: "GET",
    path: "/dashboard/agents",
    startMs,
    source: "page",
    shouldLog: true,
  });
  context.handlerStartMs = handlerStartMs;
  context.handlerMs = handlerMs;
  context.status = status;
  return context;
}

test("sequential DB timing logs precise wall-clock and additive query durations", async () => {
  await withFakeNow(async (setNow) => {
    const context = createContext(1000, 1010, 45);

    await __requestTimingTestUtils.withTimingContext(context, async () => {
      setNow(1012);
      const endFirstQuery = beginDbTiming();
      setNow(1022);
      endFirstQuery();

      setNow(1030);
      const endSecondQuery = beginDbTiming();
      setNow(1045);
      endSecondQuery();
    });

    setNow(1055);
    const line = __requestTimingTestUtils.formatHandlerDoneLog(context, 1055);
    const fields = parseLogFields(line);

    assert.equal(fields.request_ms, "55");
    assert.equal(fields.handler_ms, "45");
    assert.equal(fields.pre_handler_ms, "10");
    assert.equal(fields.db_wall_ms, "25");
    assert.equal(fields.db_query_sum_ms, "25");
    assert.equal(fields.handler_non_db_ms, "20");
    assert.equal("total_ms" in fields, false);
    assert.equal("db_ms" in fields, false);
    assert.equal("app_ms" in fields, false);
    assert.equal("render_ms" in fields, false);
  });
});

test("parallel DB timing keeps wall-clock DB time below handler and request duration", async () => {
  await withFakeNow(async (setNow) => {
    const context = createContext(2000, 2005, 25);

    await __requestTimingTestUtils.withTimingContext(context, async () => {
      setNow(2010);
      const endFirstQuery = beginDbTiming();

      setNow(2012);
      const endSecondQuery = beginDbTiming();

      setNow(2018);
      endFirstQuery();

      setNow(2022);
      endSecondQuery();
    });

    setNow(2030);
    const line = __requestTimingTestUtils.formatHandlerDoneLog(context, 2030);
    const fields = parseLogFields(line);
    const requestMs = Number(fields.request_ms);
    const handlerMs = Number(fields.handler_ms);
    const dbWallMs = Number(fields.db_wall_ms);
    const dbQuerySumMs = Number(fields.db_query_sum_ms);

    assert.equal(requestMs, 30);
    assert.equal(handlerMs, 25);
    assert.equal(dbWallMs, 12);
    assert.equal(dbQuerySumMs, 18);
    assert.equal(Number(fields.handler_non_db_ms), 13);
    assert.ok(dbQuerySumMs >= dbWallMs);
    assert.ok(dbWallMs <= handlerMs);
    assert.ok(handlerMs <= requestMs);
  });
});

test("middleware perf logs use request and middleware timing fields", () => {
  const line = withFakeNow((setNow) => {
    setNow(3000);
    return formatMiddlewareDoneLog(
      {
        requestId: "req-2",
        method: "POST",
        path: "/api/jobs",
        startMs: 2975,
      },
      401,
      3000,
    );
  });
  const fields = parseLogFields(line);

  assert.equal(fields.request_ms, "25");
  assert.equal(fields.middleware_ms, "25");
  assert.equal(fields.db_wall_ms, "0");
  assert.equal(fields.db_query_sum_ms, "0");
  assert.equal("total_ms" in fields, false);
  assert.equal("db_ms" in fields, false);
  assert.equal("app_ms" in fields, false);
  assert.equal("render_ms" in fields, false);
});

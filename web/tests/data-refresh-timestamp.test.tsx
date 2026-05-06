import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Module = require("node:module");
const testGlobals = globalThis as typeof globalThis & {
  __psTmpAliasRegistered?: boolean;
  __psDataRefreshMocksRegistered?: boolean;
  __psDataRefreshQueryCalls?: { sql: string; params?: any[] }[];
  __psDataRefreshRows?: any[];
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

if (!testGlobals.__psDataRefreshMocksRegistered) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "@/app/lib/db") {
      return {
        query: async (sql: string, params?: any[]) => {
          testGlobals.__psDataRefreshQueryCalls?.push({ sql, params });
          return testGlobals.__psDataRefreshRows ?? [];
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  testGlobals.__psDataRefreshMocksRegistered = true;
}

const {
  default: DataRefreshTimestamp,
  getLatestDataRefreshFinishedAt,
} = require("../components/data-refresh-timestamp") as typeof import("../components/data-refresh-timestamp");

test("latest data refresh lookup uses the successful finished run for the requested job", async () => {
  testGlobals.__psDataRefreshQueryCalls = [];
  testGlobals.__psDataRefreshRows = [{ finished_at: new Date("2026-05-06T15:30:00.000Z") }];

  const finishedAt = await getLatestDataRefreshFinishedAt("graph_ingest");

  assert.equal(finishedAt, "2026-05-06T15:30:00.000Z");
  assert.equal(testGlobals.__psDataRefreshQueryCalls.length, 1);
  assert.deepEqual(testGlobals.__psDataRefreshQueryCalls[0].params, ["graph_ingest"]);
  assert.match(testGlobals.__psDataRefreshQueryCalls[0].sql, /r\.status = 'success'/);
  assert.match(testGlobals.__psDataRefreshQueryCalls[0].sql, /ORDER BY r\.finished_at DESC/);
});

test("data refresh timestamp renders the shared locale-aware date component and fallback", () => {
  const markup = renderToStaticMarkup(
    React.createElement(DataRefreshTimestamp, {
      sourceLabel: "Graph sync",
      finishedAt: "2026-05-06T15:30:00.000Z",
    })
  );
  const fallbackMarkup = renderToStaticMarkup(
    React.createElement(DataRefreshTimestamp, {
      sourceLabel: "Graph sync",
      finishedAt: null,
    })
  );

  assert.match(markup, /Graph sync/);
  assert.match(markup, /data refreshed at/);
  assert.match(fallbackMarkup, /No successful refresh yet/);
});

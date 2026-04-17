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

type Stubs = Record<string, any>;

function loadRoute(stubs: Stubs) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request in stubs) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const routePath = require.resolve("../app/api/admin/agent-quarantine/export/route");
  delete require.cache[routePath];

  try {
    return require(routePath) as typeof import("../app/api/admin/agent-quarantine/export/route");
  } finally {
    Module._load = originalLoad;
  }
}

test("agent quarantine export includes reason column and value", async () => {
  const { GET } = loadRoute({
    "@/app/lib/auth": {
      requireAdmin: async () => undefined,
    },
    "@/app/admin/agent-quarantine/agent-quarantine-queries": {
      getAgentQuarantineLogsBatchAfter: async (cursor: unknown) =>
        cursor
          ? []
          : [{
              id: 1,
              occurred_at: "2026-04-16T10:00:00.000Z",
              action: "quarantine",
              request_status: "success",
              actor_name: "Admin",
              actor_upn: "admin@example.com",
              actor_oid: "oid-1",
              bot_id: "bot-1",
              bot_name: "Agent A",
              reason: "Security concern",
              resulting_is_quarantined: true,
              result_last_update_time_utc: "2026-04-16T10:00:02.000Z",
              error_detail: null,
              details: { state: "Blocked" },
            }],
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  });

  const res = await GET();
  const text = await res.text();

  assert.equal(res.status, 200);
  assert.match(text, /reason/);
  assert.match(text, /Security concern/);
});

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

function loadModule(modulePath: string, stubs: Stubs) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request in stubs) {
      return stubs[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const resolved = require.resolve(modulePath);
  const sharedPath = require.resolve("../app/api/copilot-quarantine/shared");
  delete require.cache[resolved];
  delete require.cache[sharedPath];

  try {
    return require(resolved);
  } finally {
    Module._load = originalLoad;
  }
}

test("context route returns quarantine context for admins", async () => {
  const route = loadModule("../app/api/copilot-quarantine/context/route", {
    "@/app/lib/auth": {
      requireAdmin: async () => ({ session: { user: { oid: "oid-1", upn: "admin@example.com" } } }),
    },
    "@/app/lib/copilot-quarantine": {
      fetchCopilotQuarantineContext: async () => ({
        canView: true,
        canAct: true,
        needsConsent: false,
        hasRequiredScope: true,
        roleCheck: { allowed: true, matchedRoles: ["Power Platform Administrator"], roleNames: [], checkedAt: "2026-04-16T00:00:00.000Z", error: null },
        agents: [{ botId: "bot-1", botName: "Agent A", lastUpdateTimeUtc: "2026-04-16T01:00:00.000Z", isQuarantined: false, state: "Active", actionLabel: "Block", error: null }],
      }),
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  }) as typeof import("../app/api/copilot-quarantine/context/route");

  const res = await route.GET();
  const payload = await res.json();

  assert.equal(res.status, 200);
  assert.equal(payload.canView, true);
  assert.equal(payload.agents[0].botId, "bot-1");
});

test("quarantine action logs successful requests", async () => {
  const operations: string[] = [];
  const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const route = loadModule("../app/api/copilot-quarantine/quarantine/route", {
    "@/app/lib/auth": {
      requireAdmin: async () => ({ session: { user: { oid: "oid-1", upn: "admin@example.com", name: "Admin" } } }),
    },
    "@/app/lib/csrf": {
      validateCsrfRequest: () => ({ ok: true }),
    },
    "@/app/lib/db": {
      query: async (sql: string, params?: unknown[]) => {
        queryCalls.push({ sql, params });
        if (sql.includes("INSERT INTO agent_quarantine_log")) {
          operations.push("log");
          return [];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
    "@/app/lib/license": {
      requireLicenseFeature: async () => undefined,
      LicenseFeatureError: class LicenseFeatureError extends Error {},
    },
    "@/app/lib/request-body": {
      parseRequestBody: async () => ({ invalidJson: false, body: { botId: "bot-1", botName: "Agent A", reason: "Security concern" } }),
      getNonEmptyString: (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null),
    },
    "@/app/lib/copilot-quarantine": {
      evaluateCopilotQuarantineRoles: async () => ({ allowed: true, matchedRoles: ["Power Platform Administrator"], roleNames: [], checkedAt: "2026-04-16T00:00:00.000Z", error: null }),
      toggleCopilotQuarantine: async () => {
        operations.push("toggle");
        return {
          botId: "bot-1",
          botName: "Agent A",
          lastUpdateTimeUtc: "2026-04-16T01:00:00.000Z",
          isQuarantined: true,
          state: "Blocked",
          actionLabel: "Unblock",
          error: null,
        };
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  }) as typeof import("../app/api/copilot-quarantine/quarantine/route");

  const res = await route.POST(
    new Request("http://localhost/api/copilot-quarantine/quarantine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", botName: "Agent A", reason: "Security concern" }),
    })
  );
  const payload = await res.json();

  assert.equal(res.status, 200);
  assert.equal(payload.agent.state, "Blocked");
  assert.deepEqual(operations, ["toggle", "log"]);
  assert.equal(queryCalls[0]?.params?.[7], "Security concern");
});

test("unquarantine action logs forbidden requests", async () => {
  const operations: string[] = [];
  const queryCalls: Array<{ sql: string; params?: unknown[] }> = [];
  const route = loadModule("../app/api/copilot-quarantine/unquarantine/route", {
    "@/app/lib/auth": {
      requireAdmin: async () => ({ session: { user: { oid: "oid-1", upn: "admin@example.com", name: "Admin" } } }),
    },
    "@/app/lib/csrf": {
      validateCsrfRequest: () => ({ ok: true }),
    },
    "@/app/lib/db": {
      query: async (sql: string, params?: unknown[]) => {
        queryCalls.push({ sql, params });
        if (sql.includes("INSERT INTO agent_quarantine_log")) {
          operations.push("log");
          return [];
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
    "@/app/lib/license": {
      requireLicenseFeature: async () => undefined,
      LicenseFeatureError: class LicenseFeatureError extends Error {},
    },
    "@/app/lib/request-body": {
      parseRequestBody: async () => ({ invalidJson: false, body: { botId: "bot-1", botName: "Agent A", reason: "Issue resolved" } }),
      getNonEmptyString: (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null),
    },
    "@/app/lib/copilot-quarantine": {
      evaluateCopilotQuarantineRoles: async () => ({ allowed: false, matchedRoles: [], roleNames: [], checkedAt: "2026-04-16T00:00:00.000Z", error: "copilot_quarantine_role_forbidden" }),
      toggleCopilotQuarantine: async () => {
        throw new Error("should not toggle");
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  }) as typeof import("../app/api/copilot-quarantine/unquarantine/route");

  const res = await route.POST(
    new Request("http://localhost/api/copilot-quarantine/unquarantine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", botName: "Agent A", reason: "Issue resolved" }),
    })
  );
  const payload = await res.json();

  assert.equal(res.status, 403);
  assert.equal(payload.error, "copilot_quarantine_role_forbidden");
  assert.deepEqual(operations, ["log"]);
  assert.equal(queryCalls[0]?.params?.[7], "Issue resolved");
});

test("quarantine action rejects missing reason", async () => {
  const route = loadModule("../app/api/copilot-quarantine/quarantine/route", {
    "@/app/lib/auth": {
      requireAdmin: async () => ({ session: { user: { oid: "oid-1", upn: "admin@example.com", name: "Admin" } } }),
    },
    "@/app/lib/csrf": {
      validateCsrfRequest: () => ({ ok: true }),
    },
    "@/app/lib/db": {
      query: async () => {
        throw new Error("should not write logs");
      },
    },
    "@/app/lib/license": {
      requireLicenseFeature: async () => undefined,
      LicenseFeatureError: class LicenseFeatureError extends Error {},
    },
    "@/app/lib/request-body": {
      parseRequestBody: async () => ({ invalidJson: false, body: { botId: "bot-1", botName: "Agent A", reason: "   " } }),
      getNonEmptyString: (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null),
    },
    "@/app/lib/copilot-quarantine": {
      evaluateCopilotQuarantineRoles: async () => ({ allowed: true, matchedRoles: ["Power Platform Administrator"], roleNames: [], checkedAt: "2026-04-16T00:00:00.000Z", error: null }),
      toggleCopilotQuarantine: async () => {
        throw new Error("should not toggle");
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  }) as typeof import("../app/api/copilot-quarantine/quarantine/route");

  const res = await route.POST(
    new Request("http://localhost/api/copilot-quarantine/quarantine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botId: "bot-1", botName: "Agent A", reason: "   " }),
    })
  );

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "reason is required" });
});

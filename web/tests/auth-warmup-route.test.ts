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

  const routePath = require.resolve("../app/api/auth/warmup/route");
  delete require.cache[routePath];

  try {
    return require(routePath) as typeof import("../app/api/auth/warmup/route");
  } finally {
    Module._load = originalLoad;
  }
}

test("auth warmup no-ops when no session exists", async () => {
  const { GET } = loadRoute({
    "@/app/lib/auth": {
      getSession: async () => null,
      getGroupsFromSession: () => [],
      isAdmin: () => false,
    },
    "@/app/lib/copilot-quarantine": {
      warmCopilotQuarantineAuth: async () => {
        throw new Error("should not warm");
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  });

  const res = await GET();
  const payload = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(payload, { warmed: false, reason: "no_session" });
});

test("auth warmup no-ops for non-admin sessions", async () => {
  const { GET } = loadRoute({
    "@/app/lib/auth": {
      getSession: async () => ({ user: { oid: "oid-1" }, groups: ["users"] }),
      getGroupsFromSession: () => ["users"],
      isAdmin: () => false,
    },
    "@/app/lib/copilot-quarantine": {
      warmCopilotQuarantineAuth: async () => {
        throw new Error("should not warm");
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  });

  const res = await GET();
  const payload = await res.json();

  assert.equal(res.status, 200);
  assert.deepEqual(payload, { warmed: false, reason: "not_admin" });
});

test("auth warmup primes quarantine auth state for admins", async () => {
  const { GET } = loadRoute({
    "@/app/lib/auth": {
      getSession: async () => ({ user: { oid: "oid-1", upn: "admin@example.com" }, groups: ["admins"] }),
      getGroupsFromSession: () => ["admins"],
      isAdmin: () => true,
    },
    "@/app/lib/copilot-quarantine": {
      warmCopilotQuarantineAuth: async () => ({
        isEligibleAdmin: true,
        canView: true,
        canAct: false,
        needsConsent: true,
        hasRequiredScope: false,
        roleCheck: {
          allowed: true,
          matchedRoles: ["Power Platform Administrator"],
          roleNames: ["Power Platform Administrator"],
          checkedAt: "2026-04-17T00:00:00.000Z",
          error: null,
        },
      }),
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
  });

  const res = await GET();
  const payload = await res.json();

  assert.equal(res.status, 200);
  assert.equal(payload.warmed, true);
  assert.equal(payload.isEligibleAdmin, true);
  assert.equal(payload.needsConsent, true);
  assert.equal(payload.roleCheck.allowed, true);
});

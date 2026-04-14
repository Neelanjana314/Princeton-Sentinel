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

  const routePath = require.resolve("../app/api/local-testing/license/route");
  delete require.cache[routePath];

  try {
    return require(routePath) as typeof import("../app/api/local-testing/license/route");
  } finally {
    Module._load = originalLoad;
  }
}

test("toggle route updates local testing state and writes audit metadata", async () => {
  const mutations: boolean[] = [];
  const audits: any[] = [];
  const { POST } = loadRoute({
    "@/app/lib/auth": {
      requireUser: async () => ({
        session: { user: { oid: "oid-1", upn: "user@example.com", name: "User Example" } },
      }),
    },
    "@/app/lib/audit": {
      writeAuditEvent: async (payload: any) => {
        audits.push(payload);
      },
    },
    "@/app/lib/callback-url": {
      sanitizeCallbackUrl: (value: string) => value,
    },
    "@/app/lib/csrf": {
      validateCsrfRequest: () => ({ ok: true, token: "csrf-token" }),
    },
    "@/app/lib/local-testing-state": {
      setEmulatedLicenseEnabled: async (enabled: boolean) => {
        mutations.push(enabled);
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
    "@/app/lib/runtime": {
      isLocalDockerDeployment: () => true,
    },
  });

  const form = new FormData();
  form.set("csrf_token", "csrf-token");
  form.set("callbackUrl", "/dashboard/users?tab=active");
  form.set("emulateLicenseEnabled", "false");

  const response = await POST(new Request("http://localhost/api/local-testing/license", { method: "POST", body: form }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/dashboard/users?tab=active");
  assert.deepEqual(mutations, [false]);
  assert.equal(audits[0]?.action, "local_testing_license_emulation_updated");
  assert.equal(audits[0]?.details?.emulate_license_enabled, false);
});

test("toggle route rejects non-local deployments", async () => {
  const { POST } = loadRoute({
    "@/app/lib/auth": {
      requireUser: async () => ({
        session: { user: { oid: "oid-1", upn: "user@example.com", name: "User Example" } },
      }),
    },
    "@/app/lib/audit": {
      writeAuditEvent: async () => {
        throw new Error("audit should not be called");
      },
    },
    "@/app/lib/callback-url": {
      sanitizeCallbackUrl: (value: string) => value,
    },
    "@/app/lib/csrf": {
      validateCsrfRequest: () => ({ ok: true, token: "csrf-token" }),
    },
    "@/app/lib/local-testing-state": {
      setEmulatedLicenseEnabled: async () => {
        throw new Error("mutation should not be called");
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
    "@/app/lib/runtime": {
      isLocalDockerDeployment: () => false,
    },
  });

  const response = await POST(new Request("http://localhost/api/local-testing/license", { method: "POST", body: new FormData() }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("toggle route short-circuits on csrf failure", async () => {
  const { POST } = loadRoute({
    "@/app/lib/auth": {
      requireUser: async () => ({
        session: { user: { oid: "oid-1", upn: "user@example.com", name: "User Example" } },
      }),
    },
    "@/app/lib/audit": {
      writeAuditEvent: async () => {
        throw new Error("audit should not be called");
      },
    },
    "@/app/lib/callback-url": {
      sanitizeCallbackUrl: (value: string) => value,
    },
    "@/app/lib/csrf": {
      validateCsrfRequest: () => ({ ok: false, error: "invalid_csrf_token" }),
    },
    "@/app/lib/local-testing-state": {
      setEmulatedLicenseEnabled: async () => {
        throw new Error("mutation should not be called");
      },
    },
    "@/app/lib/request-timing": {
      withApiRequestTiming: (_path: string, handler: Function) => handler,
    },
    "@/app/lib/runtime": {
      isLocalDockerDeployment: () => true,
    },
  });

  const form = new FormData();
  form.set("callbackUrl", "/dashboard");
  form.set("emulateLicenseEnabled", "true");

  const response = await POST(new Request("http://localhost/api/local-testing/license", { method: "POST", body: form }));

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/dashboard");
});

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

const originalLoad = Module._load;
Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

process.env.ENTRA_TENANT_ID = "tenant-id";
process.env.ENTRA_CLIENT_ID = "client-id";
process.env.ENTRA_CLIENT_SECRET = "client-secret";

const {
  evaluateCopilotQuarantineRoles,
  resetCopilotQuarantineCachesForTests,
} = require("../app/lib/copilot-quarantine") as typeof import("../app/lib/copilot-quarantine");
const {
  resetDelegatedAuthStateForTests,
  saveDelegatedAuthState,
  getDelegatedAuthState,
} = require("../app/lib/delegated-auth-store") as typeof import("../app/lib/delegated-auth-store");

function buildJwt(payload: Record<string, unknown>) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("role cache is invalidated when delegated auth state changes", async () => {
  resetCopilotQuarantineCachesForTests();
  resetDelegatedAuthStateForTests();

  saveDelegatedAuthState({
    oid: "oid-1",
    upn: "admin@example.com",
    refreshToken: "refresh-token-old",
  });

  const originalFetch = global.fetch;
  let tokenRequests = 0;
  let roleRequests = 0;

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/oauth2/v2.0/token")) {
      tokenRequests += 1;
      if (tokenRequests === 1) {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "interaction_required",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          access_token: buildJwt({
            scp: "Directory.Read.All",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("graph.microsoft.com")) {
      roleRequests += 1;
      return new Response(
        JSON.stringify({
          value: [{ displayName: "Power Platform Administrator" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const session = { user: { oid: "oid-1", upn: "admin@example.com" } };

    const first = await evaluateCopilotQuarantineRoles(session);
    assert.equal(first.allowed, false);
    assert.equal(first.error, "graph_consent_required");
    assert.equal(tokenRequests, 1);
    assert.equal(roleRequests, 0);

    saveDelegatedAuthState({
      oid: "oid-1",
      upn: "admin@example.com",
      refreshToken: "refresh-token-new",
    });

    const second = await evaluateCopilotQuarantineRoles(session);
    assert.equal(second.allowed, true);
    assert.deepEqual(second.matchedRoles, ["Power Platform Administrator"]);
    assert.equal(second.error, null);
    assert.equal(tokenRequests, 2);
    assert.equal(roleRequests, 1);
  } finally {
    global.fetch = originalFetch;
    resetCopilotQuarantineCachesForTests();
    resetDelegatedAuthStateForTests();
  }
});

test("consent-required role checks are retried after admin consent", async () => {
  resetCopilotQuarantineCachesForTests();
  resetDelegatedAuthStateForTests();

  saveDelegatedAuthState({
    oid: "oid-1",
    upn: "admin@example.com",
    refreshToken: "refresh-token",
  });

  const originalFetch = global.fetch;
  let tokenRequests = 0;
  let roleRequests = 0;

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/oauth2/v2.0/token")) {
      tokenRequests += 1;
      if (tokenRequests === 1) {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "AADSTS65001: consent_required",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          access_token: buildJwt({
            scp: "Directory.Read.All",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("graph.microsoft.com")) {
      roleRequests += 1;
      return new Response(
        JSON.stringify({
          value: [{ displayName: "Power Platform Administrator" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const session = { user: { oid: "oid-1", upn: "admin@example.com" } };

    const first = await evaluateCopilotQuarantineRoles(session);
    assert.equal(first.allowed, false);
    assert.equal(first.error, "graph_consent_required");
    assert.equal(tokenRequests, 1);
    assert.equal(roleRequests, 0);

    const second = await evaluateCopilotQuarantineRoles(session);
    assert.equal(second.allowed, true);
    assert.deepEqual(second.matchedRoles, ["Power Platform Administrator"]);
    assert.equal(second.error, null);
    assert.equal(tokenRequests, 2);
    assert.equal(roleRequests, 1);
  } finally {
    global.fetch = originalFetch;
    resetCopilotQuarantineCachesForTests();
    resetDelegatedAuthStateForTests();
  }
});

test("transient graph role check failures are not cached across retries", async () => {
  resetCopilotQuarantineCachesForTests();
  resetDelegatedAuthStateForTests();

  saveDelegatedAuthState({
    oid: "oid-1",
    upn: "admin@example.com",
    refreshToken: "refresh-token",
  });

  const originalFetch = global.fetch;
  let tokenRequests = 0;
  let roleRequests = 0;

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/oauth2/v2.0/token")) {
      tokenRequests += 1;
      return new Response(
        JSON.stringify({
          access_token: buildJwt({
            scp: "Directory.Read.All",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("graph.microsoft.com")) {
      roleRequests += 1;
      if (roleRequests === 1) {
        const timeoutError = new Error("aborted");
        timeoutError.name = "AbortError";
        throw timeoutError;
      }

      return new Response(
        JSON.stringify({
          value: [{ displayName: "Power Platform Administrator" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const session = { user: { oid: "oid-1", upn: "admin@example.com" } };

    const first = await evaluateCopilotQuarantineRoles(session);
    assert.equal(first.allowed, false);
    assert.equal(first.error, "graph_request_timeout");
    assert.equal(tokenRequests, 1);
    assert.equal(roleRequests, 1);

    const second = await evaluateCopilotQuarantineRoles(session);
    assert.equal(second.allowed, true);
    assert.deepEqual(second.matchedRoles, ["Power Platform Administrator"]);
    assert.equal(second.error, null);
    assert.equal(tokenRequests, 1);
    assert.equal(roleRequests, 2);
  } finally {
    global.fetch = originalFetch;
    resetCopilotQuarantineCachesForTests();
    resetDelegatedAuthStateForTests();
  }
});

test("delegated auth refresh persists rotated refresh tokens from Entra", async () => {
  resetCopilotQuarantineCachesForTests();
  resetDelegatedAuthStateForTests();

  saveDelegatedAuthState({
    oid: "oid-1",
    upn: "admin@example.com",
    refreshToken: "refresh-token-old",
  });

  const originalFetch = global.fetch;

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/oauth2/v2.0/token")) {
      return new Response(
        JSON.stringify({
          access_token: buildJwt({
            scp: "Directory.Read.All",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
          refresh_token: "refresh-token-new",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("graph.microsoft.com")) {
      return new Response(
        JSON.stringify({
          value: [{ displayName: "Power Platform Administrator" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const session = { user: { oid: "oid-1", upn: "admin@example.com" } };

    const result = await evaluateCopilotQuarantineRoles(session);
    assert.equal(result.allowed, true);
    assert.equal(
      getDelegatedAuthState("oid-1", "admin@example.com")?.refreshToken,
      "refresh-token-new"
    );
  } finally {
    global.fetch = originalFetch;
    resetCopilotQuarantineCachesForTests();
    resetDelegatedAuthStateForTests();
  }
});

test("delegated auth refresh retains the prior refresh token when Entra omits a new one", async () => {
  resetCopilotQuarantineCachesForTests();
  resetDelegatedAuthStateForTests();

  saveDelegatedAuthState({
    oid: "oid-1",
    upn: "admin@example.com",
    refreshToken: "refresh-token-old",
  });

  const originalFetch = global.fetch;

  global.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes("/oauth2/v2.0/token")) {
      return new Response(
        JSON.stringify({
          access_token: buildJwt({
            scp: "Directory.Read.All",
            exp: Math.floor(Date.now() / 1000) + 3600,
          }),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.includes("graph.microsoft.com")) {
      return new Response(
        JSON.stringify({
          value: [{ displayName: "Power Platform Administrator" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    throw new Error(`unexpected fetch url: ${url}`);
  }) as typeof fetch;

  try {
    const session = { user: { oid: "oid-1", upn: "admin@example.com" } };

    const result = await evaluateCopilotQuarantineRoles(session);
    assert.equal(result.allowed, true);
    assert.equal(
      getDelegatedAuthState("oid-1", "admin@example.com")?.refreshToken,
      "refresh-token-old"
    );
  } finally {
    global.fetch = originalFetch;
    resetCopilotQuarantineCachesForTests();
    resetDelegatedAuthStateForTests();
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import Module from "node:module";

import { NextRequest } from "next/server";

import {
  applySecurityHeaders,
  applySensitiveNoCacheHeaders,
  buildContentSecurityPolicy,
  CACHE_CONTROL_HEADER,
  CONTENT_SECURITY_POLICY_HEADER,
  GLOBAL_SECURITY_HEADERS,
  PRAGMA_HEADER,
  REFERRER_POLICY_HEADER,
  SENSITIVE_CACHE_CONTROL_DIRECTIVES,
  STRICT_TRANSPORT_SECURITY_HEADER,
  X_CONTENT_TYPE_OPTIONS_HEADER,
  X_FRAME_OPTIONS_HEADER,
} from "../app/lib/security-headers";
import { createCsrfToken, getCsrfCookieName } from "../app/lib/csrf";

const originalResolveFilename = (Module as any)._resolveFilename;
const testEnv = process.env as Record<string, string | undefined>;

function installWorkspaceAliasResolver() {
  (Module as any)._resolveFilename = function resolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown) {
    if (request.startsWith("@/")) {
      const mappedPath = path.resolve(__dirname, "..", request.slice(2));
      return originalResolveFilename.call(this, mappedPath, parent, isMain, options);
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
}

function restoreWorkspaceAliasResolver() {
  (Module as any)._resolveFilename = originalResolveFilename;
}

function setMockToken(token: Record<string, unknown> | null) {
  const jwtModule = require("next-auth/jwt");
  jwtModule.getToken = async () => token;
}

function loadProxy() {
  const proxyPath = require.resolve("../proxy");
  delete require.cache[proxyPath];
  return require("../proxy") as typeof import("../proxy");
}

function assertCspHeader(headers: Headers, options?: { nonce?: boolean }) {
  const csp = headers.get(CONTENT_SECURITY_POLICY_HEADER);
  assert.ok(csp);
  assert.match(csp!, /(^|;\s*)default-src 'self'(;|$)/);
  assert.match(csp!, /(^|;\s*)style-src 'self' 'unsafe-inline'(;|$)/);
  assert.match(csp!, /(^|;\s*)object-src 'none'(;|$)/);
  assert.match(csp!, /(^|;\s*)base-uri 'self'(;|$)/);
  assert.match(csp!, /(^|;\s*)form-action 'self'(;|$)/);
  assert.match(csp!, /(^|;\s*)frame-ancestors 'none'(;|$)/);
  if (options?.nonce) {
    assert.match(csp!, /(^|;\s*)script-src 'self' 'nonce-[^']+' 'strict-dynamic'(;|$)/);
    return;
  }
  assert.equal(csp, GLOBAL_SECURITY_HEADERS[CONTENT_SECURITY_POLICY_HEADER]);
}

function assertGlobalSecurityHeaders(headers: Headers, options?: { nonce?: boolean }) {
  assert.equal(headers.get(STRICT_TRANSPORT_SECURITY_HEADER), GLOBAL_SECURITY_HEADERS[STRICT_TRANSPORT_SECURITY_HEADER]);
  assertCspHeader(headers, options);
  assert.equal(headers.get(X_FRAME_OPTIONS_HEADER), GLOBAL_SECURITY_HEADERS[X_FRAME_OPTIONS_HEADER]);
  assert.equal(headers.get(REFERRER_POLICY_HEADER), GLOBAL_SECURITY_HEADERS[REFERRER_POLICY_HEADER]);
  assert.equal(headers.get(X_CONTENT_TYPE_OPTIONS_HEADER), GLOBAL_SECURITY_HEADERS[X_CONTENT_TYPE_OPTIONS_HEADER]);
}

function assertSensitiveNoCacheHeaders(headers: Headers) {
  const cacheControl = headers.get(CACHE_CONTROL_HEADER);
  assert.ok(cacheControl);
  for (const directive of SENSITIVE_CACHE_CONTROL_DIRECTIVES) {
    assert.match(cacheControl!, new RegExp(`(^|,\\s*)${directive}($|,\\s*)`));
  }
  assert.equal(headers.get(PRAGMA_HEADER), "no-cache");
}

test("applySecurityHeaders sets every global security header", () => {
  const response = applySecurityHeaders(new Response(null, { status: 204 }) as any);

  assertGlobalSecurityHeaders(response.headers);
});

test("buildContentSecurityPolicy adds a nonce-bound script policy when provided", () => {
  const csp = buildContentSecurityPolicy({ nonce: "test-nonce", isDevelopment: false });

  assert.match(csp, /(^|;\s*)script-src 'self' 'nonce-test-nonce' 'strict-dynamic'(;|$)/);
  assert.doesNotMatch(csp, /(^|;\s*)script-src[^;]*unsafe-inline/);
});

test("applySecurityHeaders applies a nonce-bound CSP when provided", () => {
  const response = applySecurityHeaders(new Response(null, { status: 204 }) as any, "test-nonce");

  assertGlobalSecurityHeaders(response.headers, { nonce: true });
});

test("applySensitiveNoCacheHeaders adds required anti-cache directives and preserves existing ones", () => {
  const response = applySensitiveNoCacheHeaders(
    new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "no-store, no-transform",
      },
    }),
  );

  assertSensitiveNoCacheHeaders(response.headers);
  assert.match(response.headers.get(CACHE_CONTROL_HEADER)!, /(^|,\s*)no-transform($|,\s*)/);
});

test("proxy adds security headers to unauthenticated page redirects", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    setMockToken(null);
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/dashboard?tab=summary"));

    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      "http://localhost/signin/account?callbackUrl=%2Fdashboard%3Ftab%3Dsummary",
    );
    assertGlobalSecurityHeaders(response.headers, { nonce: true });
  } finally {
    restoreWorkspaceAliasResolver();
  }
});

test("proxy adds security headers to authenticated pass-through responses", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    process.env.USER_GROUP_ID = "user-group";
    setMockToken({ groups: ["user-group"] });
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/dashboard"));

    assert.equal(response.status, 200);
    assertGlobalSecurityHeaders(response.headers, { nonce: true });
    assertSensitiveNoCacheHeaders(response.headers);
  } finally {
    delete process.env.USER_GROUP_ID;
    restoreWorkspaceAliasResolver();
  }
});

test("proxy issues a csrf cookie for authenticated requests when missing", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    process.env.USER_GROUP_ID = "user-group";
    setMockToken({ groups: ["user-group"] });
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/dashboard"));
    const setCookie = response.headers.get("set-cookie");

    assert.equal(response.status, 200);
    assert.ok(setCookie);
    assert.match(setCookie!, new RegExp(`${getCsrfCookieName()}=`));
    assert.match(setCookie!, /SameSite=Strict/i);
  } finally {
    delete process.env.USER_GROUP_ID;
    restoreWorkspaceAliasResolver();
  }
});

test("proxy reuses an existing valid csrf cookie without rewriting it", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    process.env.USER_GROUP_ID = "user-group";
    setMockToken({ groups: ["user-group"] });
    const { proxy } = loadProxy();
    const csrfToken = createCsrfToken();

    const response = await proxy(
      new NextRequest("http://localhost/dashboard", {
        headers: {
          cookie: `${getCsrfCookieName()}=${csrfToken}`,
        },
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
  } finally {
    delete process.env.USER_GROUP_ID;
    restoreWorkspaceAliasResolver();
  }
});

test("proxy adds security headers to unauthorized API responses", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    setMockToken(null);
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/api/jobs"));

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assertGlobalSecurityHeaders(response.headers, { nonce: true });
    assertSensitiveNoCacheHeaders(response.headers);
  } finally {
    restoreWorkspaceAliasResolver();
  }
});

test("proxy adds security headers to forbidden API responses", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    process.env.ADMIN_GROUP_ID = "admin-group";
    setMockToken({ groups: ["user-group"] });
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/api/jobs"));

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "forbidden" });
    assertGlobalSecurityHeaders(response.headers, { nonce: true });
    assertSensitiveNoCacheHeaders(response.headers);
  } finally {
    delete process.env.ADMIN_GROUP_ID;
    restoreWorkspaceAliasResolver();
  }
});

test("proxy adds security headers to public asset bypass responses", async () => {
  installWorkspaceAliasResolver();
  try {
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/pits-white-logo.png"));

    assert.equal(response.status, 200);
    assertGlobalSecurityHeaders(response.headers);
  } finally {
    restoreWorkspaceAliasResolver();
  }
});

test("proxy allows the post-auth bridge page without a session", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    setMockToken(null);
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("http://localhost/auth/complete?callbackUrl=%2Fdashboard"));

    assert.equal(response.status, 200);
    assertGlobalSecurityHeaders(response.headers, { nonce: true });
  } finally {
    restoreWorkspaceAliasResolver();
  }
});

test("proxy sets the last-account hint cookie with strict host-only flags", async () => {
  installWorkspaceAliasResolver();
  try {
    process.env.NEXTAUTH_SECRET = "test-secret";
    testEnv.NEXTAUTH_URL = "https://localhost:3000";
    setMockToken({ upn: "user@example.com" });
    const { proxy } = loadProxy();

    const response = await proxy(new NextRequest("https://localhost/signout"));
    const setCookie = response.headers.get("set-cookie");

    assert.equal(response.status, 200);
    assert.ok(setCookie);
    assert.match(setCookie!, /ps_last_account_hint=user%40example\.com/);
    assert.match(setCookie!, /HttpOnly/i);
    assert.match(setCookie!, /Secure/i);
    assert.match(setCookie!, /SameSite=Strict/i);
    assert.equal(/Domain=/i.test(setCookie!), false);
    assertSensitiveNoCacheHeaders(response.headers);
  } finally {
    delete testEnv.NEXTAUTH_URL;
    restoreWorkspaceAliasResolver();
  }
});

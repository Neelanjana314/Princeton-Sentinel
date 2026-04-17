import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ENTRA_TENANT_ID = "tenant-id";
process.env.ENTRA_CLIENT_ID = "client-id";
process.env.ENTRA_CLIENT_SECRET = "client-secret";
const testEnv = process.env as Record<string, string | undefined>;

const {
  getBootScopedAuthSecret,
  resetBootScopedAuthSecretForTests,
  setBootScopedAuthSecretForTests,
} = require("../app/lib/auth-secret") as typeof import("../app/lib/auth-secret");
const { getAuthOptions } = require("../app/lib/auth") as typeof import("../app/lib/auth");
const {
  clearDelegatedAuthState,
  getDelegatedAuthState,
  resetDelegatedAuthStateForTests,
} = require("../app/lib/delegated-auth-store") as typeof import("../app/lib/delegated-auth-store");
const {
  getAuthCookiePolicies,
  getSessionCookieName,
  shouldUseSecureAuthCookies,
} = require("../app/lib/auth-cookies") as typeof import("../app/lib/auth-cookies");
const { buildPostAuthBridgeUrl, POST_AUTH_BRIDGE_PATH } = require("../app/lib/callback-url") as typeof import("../app/lib/callback-url");

test("getAuthOptions configures Azure AD with PKCE", () => {
  const options = getAuthOptions();
  const provider = options.providers?.[0];

  assert.equal(provider?.id, "azure-ad");
  assert.deepEqual((provider as any)?.options?.checks, ["pkce", "state"]);
  assert.equal((provider as any)?.options?.idToken, true);
  assert.equal((provider as any)?.options?.authorization?.params?.response_mode, undefined);
  assert.match((provider as any)?.options?.authorization?.params?.scope, /offline_access/);
  assert.match((provider as any)?.options?.authorization?.params?.scope, /Directory\.Read\.All/);
  assert.match((provider as any)?.options?.authorization?.params?.scope, /CopilotStudio\.AdminActions\.Invoke/);
});

test("getAuthOptions uses the boot-scoped auth secret", () => {
  resetBootScopedAuthSecretForTests();

  try {
    setBootScopedAuthSecretForTests("test-auth-secret");

    const options = getAuthOptions();

    assert.equal(options.secret, "test-auth-secret");
    assert.equal(getBootScopedAuthSecret(), "test-auth-secret");
  } finally {
    resetBootScopedAuthSecretForTests();
  }
});

test("getAuthOptions redeems Azure auth codes with a single-resource Graph scope", async () => {
  const options = getAuthOptions();
  const provider = options.providers?.[0] as any;
  const request = provider?.options?.token?.request;

  assert.equal(typeof request, "function");

  const callbackCalls: any[] = [];
  const result = await request({
    provider: {
      callbackUrl: "https://sentinel.example.com/api/auth/callback/azure-ad",
    },
    params: {
      code: "auth-code",
      state: "state-123",
    },
    checks: {
      code_verifier: "pkce-verifier",
      state: "state-123",
    },
    client: {
      callback: async (...args: any[]) => {
        callbackCalls.push(args);
        return {
          access_token: "provider-access-token",
          id_token: "provider-id-token",
          refresh_token: "provider-refresh-token",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          scope: "openid profile email offline_access https://graph.microsoft.com/Directory.Read.All",
        };
      },
    },
  });

  assert.equal(callbackCalls.length, 1);
  assert.deepEqual(callbackCalls[0][3], {
    exchangeBody: {
      scope: "openid profile email offline_access https://graph.microsoft.com/Directory.Read.All",
    },
  });
  assert.equal(result.tokens.access_token, "provider-access-token");
});

test("getAuthOptions hardens auth cookies without breaking OAuth callbacks", () => {
  testEnv.NEXTAUTH_URL = "https://sentinel.example.com";

  const options = getAuthOptions();
  const cookies = options.cookies;

  assert.ok(cookies);
  assert.equal(shouldUseSecureAuthCookies(), true);
  assert.equal(getSessionCookieName(), "__Host-next-auth.session-token");
  assert.equal(cookies?.sessionToken.name, "__Host-next-auth.session-token");
  assert.equal(cookies?.sessionToken.options.httpOnly, true);
  assert.equal(cookies?.sessionToken.options.sameSite, "strict");
  assert.equal(cookies?.sessionToken.options.secure, true);
  assert.equal(cookies?.callbackUrl.options.sameSite, "lax");
  assert.equal(cookies?.csrfToken.options.sameSite, "strict");
  assert.equal(cookies?.pkceCodeVerifier.options.sameSite, "lax");
  assert.equal(cookies?.state.options.sameSite, "lax");
  assert.equal("domain" in cookies?.sessionToken.options, false);
});

test("auth cookie policy stays compatible with local http localhost", () => {
  testEnv.NODE_ENV = "production";
  testEnv.NEXTAUTH_URL = "http://localhost:3000";
  delete testEnv.AUTH_URL;
  delete testEnv.VERCEL;

  const cookies = getAuthCookiePolicies();

  assert.equal(shouldUseSecureAuthCookies(), false);
  assert.equal(getSessionCookieName(), "next-auth.session-token");
  assert.equal(cookies.sessionToken.name, "next-auth.session-token");
  assert.equal(cookies.sessionToken.options.secure, false);
  assert.equal(cookies.sessionToken.options.sameSite, "strict");
});

test("post-auth redirect callback routes successful sign-ins through the bridge page", async () => {
  const options = getAuthOptions();
  const redirect = options.callbacks?.redirect;

  assert.ok(redirect);
  assert.equal(
    await redirect?.({
      url: "/dashboard?tab=summary",
      baseUrl: "https://sentinel.example.com",
    } as any),
    `https://sentinel.example.com${POST_AUTH_BRIDGE_PATH}?callbackUrl=%2Fdashboard%3Ftab%3Dsummary`,
  );
});

test("post-auth bridge bypasses sign-in and sign-out destinations", () => {
  assert.equal(
    buildPostAuthBridgeUrl("/signin/account?callbackUrl=%2Fdashboard", "https://sentinel.example.com"),
    "https://sentinel.example.com/signin/account?callbackUrl=%2Fdashboard",
  );
  assert.equal(
    buildPostAuthBridgeUrl("/signout?callbackUrl=%2Fsignin%2Faccount", "https://sentinel.example.com"),
    "https://sentinel.example.com/signout?callbackUrl=%2Fsignin%2Faccount",
  );
});

test("jwt callback derives claims without persisting provider tokens", async () => {
  resetDelegatedAuthStateForTests();
  const options = getAuthOptions();
  const jwt = options.callbacks?.jwt;
  assert.ok(jwt);

  const token = await jwt?.({
    token: {},
    account: {
      id_token:
        "header.eyJvaWQiOiJvaWQtMSIsInByZWZlcnJlZF91c2VybmFtZSI6InVzZXJAZXhhbXBsZS5jb20iLCJncm91cHMiOlsiZ3JvdXAtMSJdfQ.signature",
      access_token: "provider-access-token",
      refresh_token: "provider-refresh-token",
      scope: "openid offline_access https://graph.microsoft.com/Directory.Read.All https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    } as any,
    profile: {
      oid: "profile-oid",
      upn: "profile@example.com",
      groups: ["profile-group"],
    } as any,
    user: undefined as any,
    trigger: "signIn",
    isNewUser: false,
    session: undefined,
  });

  assert.deepEqual(token, {
    oid: "oid-1",
    upn: "user@example.com",
    groups: ["group-1"],
  });
  assert.equal("accessToken" in (token as object), false);
  assert.equal("idToken" in (token as object), false);
  assert.deepEqual(getDelegatedAuthState("oid-1", "user@example.com"), {
    key: "oid:oid-1",
    oid: "oid-1",
    upn: "user@example.com",
    accessToken: "provider-access-token",
    accessTokenExpiresAt: (getDelegatedAuthState("oid-1", "user@example.com") as any)?.accessTokenExpiresAt,
    refreshToken: "provider-refresh-token",
    scope: "openid offline_access https://graph.microsoft.com/Directory.Read.All https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke",
    updatedAt: (getDelegatedAuthState("oid-1", "user@example.com") as any)?.updatedAt,
  });
  assert.equal((getDelegatedAuthState("oid-1", "user@example.com") as any)?.refreshToken, "provider-refresh-token");
});

test("session callback does not expose provider access tokens", async () => {
  const options = getAuthOptions();
  const sessionCallback = options.callbacks?.session;
  assert.ok(sessionCallback);

  const session = await sessionCallback?.({
    session: { user: { name: "Example User", email: "user@example.com", image: null } } as any,
    token: {
      accessToken: "provider-access-token",
      oid: "oid-1",
      upn: "user@example.com",
      groups: ["group-1"],
    } as any,
    user: undefined as any,
    newSession: undefined as any,
    trigger: "update",
  });

  assert.deepEqual(session, {
    user: {
      name: "Example User",
      email: "user@example.com",
      image: null,
      oid: "oid-1",
      upn: "user@example.com",
      groups: ["group-1"],
    },
    groups: ["group-1"],
  });
  assert.equal("accessToken" in (session as object), false);
});

test("signOut event clears delegated auth state", async () => {
  resetDelegatedAuthStateForTests();
  const options = getAuthOptions();
  const signOut = options.events?.signOut;

  assert.ok(signOut);

  const saved = getDelegatedAuthState("oid-1", "user@example.com");
  assert.equal(saved, null);

  clearDelegatedAuthState("oid-1", "user@example.com");
  const jwt = options.callbacks?.jwt;
  assert.ok(jwt);
  await jwt?.({
    token: { oid: "oid-1", upn: "user@example.com" },
    account: {
      access_token: "provider-access-token",
      refresh_token: "provider-refresh-token",
      scope: "openid offline_access https://graph.microsoft.com/Directory.Read.All https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    } as any,
    profile: undefined,
    user: undefined as any,
    trigger: "signIn",
    isNewUser: false,
    session: undefined,
  });

  assert.ok(getDelegatedAuthState("oid-1", "user@example.com"));

  await signOut?.({
    token: { oid: "oid-1", upn: "user@example.com" },
  } as any);

  assert.equal(getDelegatedAuthState("oid-1", "user@example.com"), null);
});

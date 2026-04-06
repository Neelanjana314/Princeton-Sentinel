import { test } from "node:test";
import assert from "node:assert/strict";

process.env.ENTRA_TENANT_ID = "tenant-id";
process.env.ENTRA_CLIENT_ID = "client-id";
process.env.ENTRA_CLIENT_SECRET = "client-secret";
const testEnv = process.env as Record<string, string | undefined>;

const { getAuthOptions } = require("../app/lib/auth") as typeof import("../app/lib/auth");
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
  assert.equal((provider as any)?.options?.authorization?.params?.response_mode, undefined);
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
  const options = getAuthOptions();
  const jwt = options.callbacks?.jwt;
  assert.ok(jwt);

  const token = await jwt?.({
    token: {},
    account: {
      id_token:
        "header.eyJvaWQiOiJvaWQtMSIsInByZWZlcnJlZF91c2VybmFtZSI6InVzZXJAZXhhbXBsZS5jb20iLCJncm91cHMiOlsiZ3JvdXAtMSJdfQ.signature",
      access_token: "provider-access-token",
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

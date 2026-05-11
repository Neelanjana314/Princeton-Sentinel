import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import {
  PS_REQ_ID_HEADER,
  PS_REQ_METHOD_HEADER,
  PS_REQ_PATH_HEADER,
  PS_REQ_START_MS_HEADER,
} from "@/app/lib/request-timing-headers";
import { formatMiddlewareDoneLog } from "@/app/lib/request-timing";
import {
  LAST_ACCOUNT_HINT_COOKIE,
  LAST_ACCOUNT_HINT_MAX_AGE_SECONDS,
  sanitizeAccountHint,
} from "@/app/lib/account-hint";
import { getBootScopedAuthSecret } from "@/app/lib/auth-secret";
import { attachCsrfCookie, CSRF_REQUEST_TOKEN_HEADER, ensureCsrfToken, getCsrfCookieName } from "@/app/lib/csrf";
import {
  applySecurityHeaders,
  applySensitiveNoCacheHeaders,
  buildContentSecurityPolicy,
  CONTENT_SECURITY_POLICY_HEADER,
  NONCE_HEADER,
} from "./app/lib/security-headers";

const ADMIN_PREFIXES = [
  "/admin",
  "/analytics",
  "/jobs",
  "/license",
  "/runs",
  "/api/license",
  "/api/worker",
  "/api/jobs",
  "/api/schedules",
  "/api/runs",
  "/api/analytics",
  "/api/agents/access-blocks",
  "/api/copilot-quarantine",
];
const USER_PREFIXES = ["/dashboard", "/sites", "/testing", "/api/graph", "/api/feature-flags", "/api/local-testing"];
const KEY_VAULT_SCOPE = "https://vault.azure.net";
const KEY_VAULT_UNSET_VALUE = "__PRINCETON_SENTINEL_UNSET__";

type TimingMeta = {
  requestId: string;
  method: string;
  path: string;
  startMs: number;
};

let proxyTokenCache: { token: string; expiresAtMs: number } | null = null;
const proxyLastKnownGood = new Map<string, string>();

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function isPublicAsset(pathname: string) {
  return /\.[^/]+$/.test(pathname);
}

function isTruthy(value: string | undefined) {
  return Boolean(value && ["1", "true", "t", "yes", "y", "on"].includes(value.trim().toLowerCase()));
}

function isProxyKeyVaultEnabled() {
  return Boolean(process.env.AZ_KEY_VAULT_URL?.trim()) && !isTruthy(process.env.LOCAL_DOCKER_DEPLOYMENT);
}

function parseProxyTokenExpiresAt(payload: Record<string, any>) {
  const expiresOn = payload.expires_on ?? payload.expiresOn;
  if (typeof expiresOn === "number") return expiresOn > 10_000_000_000 ? expiresOn : expiresOn * 1000;
  if (typeof expiresOn === "string" && /^\d+$/.test(expiresOn)) {
    const parsed = Number(expiresOn);
    return parsed > 10_000_000_000 ? parsed : parsed * 1000;
  }
  const expiresIn = payload.expires_in ?? payload.expiresIn;
  if (typeof expiresIn === "number") return Date.now() + expiresIn * 1000;
  if (typeof expiresIn === "string" && /^\d+$/.test(expiresIn)) return Date.now() + Number(expiresIn) * 1000;
  return Date.now() + 55 * 60 * 1000;
}

async function acquireProxyManagedIdentityToken() {
  if (proxyTokenCache && Date.now() < proxyTokenCache.expiresAtMs - 60_000) {
    return proxyTokenCache.token;
  }
  const endpoint = process.env.IDENTITY_ENDPOINT;
  const identityHeader = process.env.IDENTITY_HEADER;
  const clientId = process.env.MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
  let response: Response;
  if (endpoint && identityHeader) {
    const url = new URL(endpoint);
    url.searchParams.set("api-version", "2019-08-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) url.searchParams.set("client_id", clientId);
    response = await fetch(url, { headers: { "X-IDENTITY-HEADER": identityHeader, Metadata: "true" } });
  } else {
    const url = new URL("http://169.254.169.254/metadata/identity/oauth2/token");
    url.searchParams.set("api-version", "2018-02-01");
    url.searchParams.set("resource", KEY_VAULT_SCOPE);
    if (clientId) url.searchParams.set("client_id", clientId);
    response = await fetch(url, { headers: { Metadata: "true" } });
  }
  if (!response.ok) throw new Error(`managed_identity_token_failed_${response.status}`);
  const payload = await response.json().catch(() => ({}));
  if (!payload.access_token) throw new Error("managed_identity_token_missing_access_token");
  proxyTokenCache = { token: payload.access_token, expiresAtMs: parseProxyTokenExpiresAt(payload) };
  return proxyTokenCache.token;
}

async function getProxyRuntimeEnv(name: string) {
  const existing = process.env[name];
  if (!isProxyKeyVaultEnabled()) {
    return existing;
  }
  try {
    const vaultUrl = String(process.env.AZ_KEY_VAULT_URL || "").trim().replace(/\/+$/, "");
    const secretName = name.replaceAll("_", "-");
    const token = await acquireProxyManagedIdentityToken();
    const response = await fetch(`${vaultUrl}/secrets/${encodeURIComponent(secretName)}?api-version=7.4`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 404) {
      proxyLastKnownGood.delete(name);
      return undefined;
    }
    if (!response.ok) throw new Error(`key_vault_secret_lookup_failed_${name}_${response.status}`);
    const payload = await response.json().catch(() => ({}));
    const value = typeof payload.value === "string" ? payload.value : "";
    if (!value.trim() || value === KEY_VAULT_UNSET_VALUE) {
      proxyLastKnownGood.delete(name);
      return undefined;
    }
    proxyLastKnownGood.set(name, value);
    return value;
  } catch (error) {
    const stale = proxyLastKnownGood.get(name) || (existing?.trim() ? existing : undefined);
    if (stale) {
      console.warn(`Key Vault runtime config lookup failed for ${name}; using last-known-good value`);
      return stale;
    }
    throw error;
  }
}

async function shouldUseSecureProxyAuthCookies() {
  const authUrl = (await getProxyRuntimeEnv("NEXTAUTH_URL")) || process.env.AUTH_URL;
  if (authUrl) {
    try {
      return new URL(authUrl).protocol === "https:";
    } catch {
      return authUrl.startsWith("https://");
    }
  }
  return Boolean(process.env.VERCEL);
}

async function getProxySessionCookieName() {
  return `${(await shouldUseSecureProxyAuthCookies()) ? "__Host-" : ""}next-auth.session-token`;
}

function createContentSecurityPolicyNonce() {
  const nonceSource = crypto.randomUUID();
  if (typeof btoa === "function") {
    return btoa(nonceSource);
  }
  return Buffer.from(nonceSource).toString("base64");
}

function forbiddenRedirect(req: NextRequest, nonce: string) {
  const url = req.nextUrl.clone();
  url.pathname = "/forbidden";
  url.search = "";
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return applySecurityHeaders(NextResponse.redirect(url), nonce);
}

function createTimingMeta(req: NextRequest): TimingMeta {
  return {
    requestId: crypto.randomUUID(),
    method: req.method.toUpperCase(),
    path: req.nextUrl.pathname,
    startMs: Date.now(),
  };
}

function upsertCookieHeader(cookieHeader: string | null, name: string, value: string) {
  const parts = (cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith(`${name}=`));

  parts.push(`${name}=${value}`);
  return parts.join("; ");
}

function nextWithTiming(req: NextRequest, timing: TimingMeta, nonce: string, csrfToken?: string, persistCsrfCookie = false) {
  const headers = new Headers(req.headers);
  headers.set(PS_REQ_ID_HEADER, timing.requestId);
  headers.set(PS_REQ_START_MS_HEADER, String(timing.startMs));
  headers.set(PS_REQ_METHOD_HEADER, timing.method);
  headers.set(PS_REQ_PATH_HEADER, timing.path);
  headers.set(NONCE_HEADER, nonce);
  headers.set(CONTENT_SECURITY_POLICY_HEADER, buildContentSecurityPolicy({ nonce }));
  if (csrfToken) {
    headers.set(CSRF_REQUEST_TOKEN_HEADER, csrfToken);
    headers.set("cookie", upsertCookieHeader(req.headers.get("cookie"), getCsrfCookieName(), csrfToken));
  }
  const response = applySecurityHeaders(
    NextResponse.next({
      request: {
        headers,
      },
    }),
    nonce,
  );
  if (csrfToken && persistCsrfCookie) {
    attachCsrfCookie(response, csrfToken);
  }
  return response;
}

function applyProtectedResponseHeaders<T extends NextResponse>(response: T, nonce: string): T {
  return applySensitiveNoCacheHeaders(applySecurityHeaders(response, nonce));
}

function logPerfDoneFromMiddleware(timing: TimingMeta, status: number) {
  console.log(formatMiddlewareDoneLog(timing, status));
}

function clearLastAccountHintCookie(response: NextResponse) {
  response.cookies.set({
    name: LAST_ACCOUNT_HINT_COOKIE,
    value: "",
    path: "/",
    maxAge: 0,
  });
}

async function setLastAccountHintCookie(response: NextResponse, hint: string) {
  response.cookies.set({
    name: LAST_ACCOUNT_HINT_COOKIE,
    value: hint,
    httpOnly: true,
    sameSite: "strict",
    secure: await shouldUseSecureProxyAuthCookies(),
    path: "/",
    maxAge: LAST_ACCOUNT_HINT_MAX_AGE_SECONDS,
  });
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const timing = createTimingMeta(req);
  const nonce = createContentSecurityPolicyNonce();

  if (pathname.startsWith("/api/auth") || pathname.startsWith("/_next") || pathname === "/favicon.ico" || isPublicAsset(pathname)) {
    const response = applySecurityHeaders(NextResponse.next());
    return pathname.startsWith("/api/auth") ? applySensitiveNoCacheHeaders(response) : response;
  }
  if (pathname.startsWith("/api/internal/worker-heartbeat")) {
    return applyProtectedResponseHeaders(NextResponse.next(), nonce);
  }
  if (pathname.startsWith("/signout")) {
    const response = applySensitiveNoCacheHeaders(nextWithTiming(req, timing, nonce));
    const token = await getToken({
      req,
      secret: getBootScopedAuthSecret(),
      secureCookie: await shouldUseSecureProxyAuthCookies(),
      cookieName: await getProxySessionCookieName(),
    });
    const accountHint = sanitizeAccountHint(
      typeof token?.upn === "string" ? token.upn : typeof token?.email === "string" ? token.email : undefined,
    );
    if (accountHint) {
      await setLastAccountHintCookie(response, accountHint);
    } else {
      clearLastAccountHintCookie(response);
    }
    return response;
  }

  if (pathname.startsWith("/signin/account") || pathname.startsWith("/auth/complete")) {
    const response = applySensitiveNoCacheHeaders(nextWithTiming(req, timing, nonce));
    if (req.nextUrl.searchParams.get("clearHint") === "1") {
      clearLastAccountHintCookie(response);
    }
    return response;
  }

  if (pathname.startsWith("/signin") || pathname.startsWith("/forbidden") || pathname.startsWith("/403")) {
    return nextWithTiming(req, timing, nonce);
  }

  const token = await getToken({
    req,
    secret: getBootScopedAuthSecret(),
    secureCookie: await shouldUseSecureProxyAuthCookies(),
    cookieName: await getProxySessionCookieName(),
  });
  if (!token) {
    if (isApiRequest(pathname)) {
      const response = applyProtectedResponseHeaders(NextResponse.json({ error: "unauthorized" }, { status: 401 }), nonce);
      logPerfDoneFromMiddleware(timing, response.status);
      return response;
    }
    const signInUrl = new URL("/signin/account", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", pathname + search);
    const response = applyProtectedResponseHeaders(NextResponse.redirect(signInUrl), nonce);
    logPerfDoneFromMiddleware(timing, response.status);
    return response;
  }

  const groups = (token.groups as string[]) || [];
  const [adminGroup, userGroup] = await Promise.all([
    getProxyRuntimeEnv("ADMIN_GROUP_ID"),
    getProxyRuntimeEnv("USER_GROUP_ID"),
  ]);
  const isAdmin = adminGroup ? groups.includes(adminGroup) : false;
  const isUser = isAdmin || (userGroup ? groups.includes(userGroup) : false);
  const existingCsrfToken = req.cookies.get(getCsrfCookieName())?.value;
  const csrfToken = ensureCsrfToken(existingCsrfToken);
  const persistCsrfCookie = csrfToken !== existingCsrfToken;

  if (ADMIN_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!isAdmin) {
      if (isApiRequest(pathname)) {
        const response = applyProtectedResponseHeaders(NextResponse.json({ error: "forbidden" }, { status: 403 }), nonce);
        logPerfDoneFromMiddleware(timing, response.status);
        return response;
      }
      const response = applySensitiveNoCacheHeaders(forbiddenRedirect(req, nonce));
      logPerfDoneFromMiddleware(timing, response.status);
      return response;
    }
  }

  if (USER_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!isUser) {
      if (isApiRequest(pathname)) {
        const response = applyProtectedResponseHeaders(NextResponse.json({ error: "forbidden" }, { status: 403 }), nonce);
        logPerfDoneFromMiddleware(timing, response.status);
        return response;
      }
      const response = applySensitiveNoCacheHeaders(forbiddenRedirect(req, nonce));
      logPerfDoneFromMiddleware(timing, response.status);
      return response;
    }
  }

  return applyProtectedResponseHeaders(nextWithTiming(req, timing, nonce, csrfToken, persistCsrfCookie), nonce);
}

export const config = {
  // Match every request so framework-served assets also receive shared security headers.
  matcher: ["/:path*"],
};

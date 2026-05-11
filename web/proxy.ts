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
import { getSessionCookieName, shouldUseSecureAuthCookies } from "@/app/lib/auth-cookies";
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

type TimingMeta = {
  requestId: string;
  method: string;
  path: string;
  startMs: number;
};

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function isPublicAsset(pathname: string) {
  return /\.[^/]+$/.test(pathname);
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

function setLastAccountHintCookie(response: NextResponse, hint: string) {
  response.cookies.set({
    name: LAST_ACCOUNT_HINT_COOKIE,
    value: hint,
    httpOnly: true,
    sameSite: "strict",
    secure: shouldUseSecureAuthCookies(),
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
      secureCookie: shouldUseSecureAuthCookies(),
      cookieName: getSessionCookieName(),
    });
    const accountHint = sanitizeAccountHint(
      typeof token?.upn === "string" ? token.upn : typeof token?.email === "string" ? token.email : undefined,
    );
    if (accountHint) {
      setLastAccountHintCookie(response, accountHint);
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
    secureCookie: shouldUseSecureAuthCookies(),
    cookieName: getSessionCookieName(),
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
  const adminGroup = process.env.ADMIN_GROUP_ID;
  const userGroup = process.env.USER_GROUP_ID;
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

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import {
  PS_REQ_ID_HEADER,
  PS_REQ_METHOD_HEADER,
  PS_REQ_PATH_HEADER,
  PS_REQ_START_MS_HEADER,
} from "@/app/lib/request-timing-headers";
import {
  LAST_ACCOUNT_HINT_COOKIE,
  LAST_ACCOUNT_HINT_MAX_AGE_SECONDS,
  sanitizeAccountHint,
} from "@/app/lib/account-hint";

const ADMIN_PREFIXES = [
  "/admin",
  "/analytics",
  "/jobs",
  "/runs",
  "/api/worker",
  "/api/jobs",
  "/api/schedules",
  "/api/runs",
  "/api/analytics",
];
const USER_PREFIXES = ["/dashboard", "/sites", "/api/graph", "/api/feature-flags"];
const LOG_PREFIX = "[PERF] [WEBAPP]";

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

function forbiddenRedirect(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/forbidden";
  url.search = "";
  url.searchParams.set("callbackUrl", req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

function createTimingMeta(req: NextRequest): TimingMeta {
  return {
    requestId: crypto.randomUUID(),
    method: req.method.toUpperCase(),
    path: req.nextUrl.pathname,
    startMs: Date.now(),
  };
}

function nextWithTiming(req: NextRequest, timing: TimingMeta) {
  const headers = new Headers(req.headers);
  headers.set(PS_REQ_ID_HEADER, timing.requestId);
  headers.set(PS_REQ_START_MS_HEADER, String(timing.startMs));
  headers.set(PS_REQ_METHOD_HEADER, timing.method);
  headers.set(PS_REQ_PATH_HEADER, timing.path);
  return NextResponse.next({
    request: {
      headers,
    },
  });
}

function logPerfDoneFromMiddleware(timing: TimingMeta, status: number) {
  const totalMs = Math.max(0, Math.round(Date.now() - timing.startMs));
  console.log(
    `${LOG_PREFIX} done req_id=${timing.requestId} source=app method=${timing.method} path=${timing.path} status=${status} total_ms=${totalMs} db_ms=0 app_ms=${totalMs} render_ms=0`
  );
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
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: LAST_ACCOUNT_HINT_MAX_AGE_SECONDS,
  });
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (pathname.startsWith("/api/auth") || pathname.startsWith("/_next") || pathname === "/favicon.ico" || isPublicAsset(pathname)) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/internal/worker-heartbeat")) {
    return NextResponse.next();
  }
  const timing = createTimingMeta(req);

  if (pathname.startsWith("/signout")) {
    const response = nextWithTiming(req, timing);
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
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

  if (pathname.startsWith("/signin/account")) {
    const response = nextWithTiming(req, timing);
    if (req.nextUrl.searchParams.get("clearHint") === "1") {
      clearLastAccountHintCookie(response);
    }
    return response;
  }

  if (pathname.startsWith("/signin") || pathname.startsWith("/forbidden") || pathname.startsWith("/403")) {
    return nextWithTiming(req, timing);
  }

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  if (!token) {
    if (isApiRequest(pathname)) {
      const response = NextResponse.json({ error: "unauthorized" }, { status: 401 });
      logPerfDoneFromMiddleware(timing, response.status);
      return response;
    }
    const signInUrl = new URL("/signin/account", req.nextUrl.origin);
    signInUrl.searchParams.set("callbackUrl", pathname + search);
    const response = NextResponse.redirect(signInUrl);
    logPerfDoneFromMiddleware(timing, response.status);
    return response;
  }

  const groups = (token.groups as string[]) || [];
  const adminGroup = process.env.ADMIN_GROUP_ID;
  const userGroup = process.env.USER_GROUP_ID;
  const isAdmin = adminGroup ? groups.includes(adminGroup) : false;
  const isUser = isAdmin || (userGroup ? groups.includes(userGroup) : false);

  if (ADMIN_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!isAdmin) {
      if (isApiRequest(pathname)) {
        const response = NextResponse.json({ error: "forbidden" }, { status: 403 });
        logPerfDoneFromMiddleware(timing, response.status);
        return response;
      }
      const response = forbiddenRedirect(req);
      logPerfDoneFromMiddleware(timing, response.status);
      return response;
    }
  }

  if (USER_PREFIXES.some((p) => pathname.startsWith(p))) {
    if (!isUser) {
      if (isApiRequest(pathname)) {
        const response = NextResponse.json({ error: "forbidden" }, { status: 403 });
        logPerfDoneFromMiddleware(timing, response.status);
        return response;
      }
      const response = forbiddenRedirect(req);
      logPerfDoneFromMiddleware(timing, response.status);
      return response;
    }
  }

  return nextWithTiming(req, timing);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

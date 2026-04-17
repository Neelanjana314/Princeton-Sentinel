import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { shouldUseSecureAuthCookies } from "./auth-cookies";
import { getBootScopedAuthSecret } from "./auth-secret";
import {
  CSRF_FORM_FIELD_NAME,
  CSRF_HEADER_NAME,
  LOCAL_CSRF_COOKIE_NAME,
  parseCookieValue,
  SECURE_CSRF_COOKIE_NAME,
} from "./csrf-shared";

export { CSRF_FORM_FIELD_NAME, CSRF_HEADER_NAME, CSRF_REQUEST_TOKEN_HEADER } from "./csrf-shared";

type CsrfValidationResult =
  | { ok: true; token: string }
  | { ok: false; error: "missing_csrf_token" | "invalid_csrf_token" };

function getCsrfSecret() {
  return process.env.CSRF_SECRET || getBootScopedAuthSecret();
}

export function getCsrfCookieName() {
  return shouldUseSecureAuthCookies() ? SECURE_CSRF_COOKIE_NAME : LOCAL_CSRF_COOKIE_NAME;
}

function signNonce(nonce: string) {
  return createHmac("sha256", getCsrfSecret()).update(nonce).digest("base64url");
}

export function createCsrfToken() {
  const nonce = randomBytes(32).toString("base64url");
  return `${nonce}.${signNonce(nonce)}`;
}

export function isValidCsrfToken(token: string | null | undefined): token is string {
  if (!token || typeof token !== "string") return false;
  const separatorIndex = token.lastIndexOf(".");
  if (separatorIndex <= 0 || separatorIndex >= token.length - 1) return false;

  const nonce = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (!nonce || !signature) return false;

  const expected = signNonce(nonce);
  const actualBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function getRequestCsrfToken(req: Request, body?: Record<string, unknown>, explicitToken?: string | null) {
  if (explicitToken && explicitToken.trim()) {
    return explicitToken.trim();
  }

  const headerToken = req.headers.get(CSRF_HEADER_NAME);
  if (headerToken && headerToken.trim()) {
    return headerToken.trim();
  }

  const bodyToken = body?.[CSRF_FORM_FIELD_NAME];
  if (typeof bodyToken === "string" && bodyToken.trim()) {
    return bodyToken.trim();
  }

  return null;
}

export function validateCsrfRequest(
  req: Request,
  body?: Record<string, unknown>,
  explicitToken?: string | null,
): CsrfValidationResult {
  const cookieToken = parseCookieValue(req.headers.get("cookie"), getCsrfCookieName());
  const requestToken = getRequestCsrfToken(req, body, explicitToken);

  if (!cookieToken || !requestToken) {
    return { ok: false, error: "missing_csrf_token" };
  }

  if (!isValidCsrfToken(cookieToken) || !isValidCsrfToken(requestToken)) {
    return { ok: false, error: "invalid_csrf_token" };
  }

  const cookieBuffer = Buffer.from(cookieToken, "utf8");
  const requestBuffer = Buffer.from(requestToken, "utf8");
  if (cookieBuffer.length !== requestBuffer.length || !timingSafeEqual(cookieBuffer, requestBuffer)) {
    return { ok: false, error: "invalid_csrf_token" };
  }

  return { ok: true, token: requestToken };
}

export function ensureCsrfToken(existingToken?: string | null) {
  return isValidCsrfToken(existingToken) ? existingToken : createCsrfToken();
}

export function attachCsrfCookie(response: NextResponse, token: string) {
  response.cookies.set({
    name: getCsrfCookieName(),
    value: token,
    httpOnly: false,
    sameSite: "strict",
    secure: shouldUseSecureAuthCookies(),
    path: "/",
  });
}

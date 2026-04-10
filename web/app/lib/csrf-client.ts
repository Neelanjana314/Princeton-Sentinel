import { CSRF_HEADER_NAME, LOCAL_CSRF_COOKIE_NAME, parseCookieValue, SECURE_CSRF_COOKIE_NAME } from "@/app/lib/csrf-shared";

export function getCsrfTokenFromDocumentCookie() {
  if (typeof document === "undefined") {
    return null;
  }
  const cookieHeader = document.cookie || null;
  return parseCookieValue(cookieHeader, SECURE_CSRF_COOKIE_NAME) ?? parseCookieValue(cookieHeader, LOCAL_CSRF_COOKIE_NAME);
}

export function getCsrfFetchHeaders(headers?: HeadersInit) {
  const nextHeaders = new Headers(headers);
  const csrfToken = getCsrfTokenFromDocumentCookie();
  if (csrfToken) {
    nextHeaders.set(CSRF_HEADER_NAME, csrfToken);
  }
  return nextHeaders;
}

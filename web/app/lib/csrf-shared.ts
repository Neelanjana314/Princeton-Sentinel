export const CSRF_HEADER_NAME = "x-csrf-token";
export const CSRF_FORM_FIELD_NAME = "csrf_token";
export const CSRF_REQUEST_TOKEN_HEADER = "x-ps-csrf-token";
export const SECURE_CSRF_COOKIE_NAME = "__Host-ps.csrf-token";
export const LOCAL_CSRF_COOKIE_NAME = "ps.csrf-token";

export function parseCookieValue(cookieHeader: string | null, cookieName: string) {
  if (!cookieHeader) return null;

  for (const cookie of cookieHeader.split(";")) {
    const trimmed = cookie.trim();
    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) continue;

    const name = trimmed.slice(0, separatorIndex).trim();
    if (name !== cookieName) continue;

    return trimmed.slice(separatorIndex + 1).trim();
  }

  return null;
}

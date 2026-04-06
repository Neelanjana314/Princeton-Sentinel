const DEFAULT_CALLBACK_URL = "/dashboard";
export const POST_AUTH_BRIDGE_PATH = "/auth/complete";

function normalizeInput(input?: string | string[] | null): string | undefined {
  if (!input) return undefined;
  return Array.isArray(input) ? input[0] : input;
}

export function sanitizeCallbackUrl(
  input?: string | string[] | null,
  fallback: string = DEFAULT_CALLBACK_URL,
): string {
  const value = normalizeInput(input)?.trim();
  if (!value) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/[\x00-\x1F\x7F]/.test(value)) return fallback;

  try {
    const parsed = new URL(value, "http://localhost");
    if (parsed.origin !== "http://localhost") return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function buildSignInAccountUrl(callbackUrl: string): string {
  const params = new URLSearchParams({ callbackUrl });
  return `/signin/account?${params.toString()}`;
}

function normalizeNextAuthCallbackTarget(url: string, baseUrl: string): string {
  if (url.startsWith("/")) {
    return sanitizeCallbackUrl(url);
  }

  try {
    const parsed = new URL(url);
    const base = new URL(baseUrl);
    if (parsed.origin !== base.origin) {
      return DEFAULT_CALLBACK_URL;
    }
    return sanitizeCallbackUrl(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return DEFAULT_CALLBACK_URL;
  }
}

function shouldBypassPostAuthBridge(callbackUrl: string): boolean {
  return (
    callbackUrl.startsWith("/signin") ||
    callbackUrl.startsWith("/signout") ||
    callbackUrl.startsWith("/forbidden") ||
    callbackUrl.startsWith("/403") ||
    callbackUrl.startsWith("/api/auth") ||
    callbackUrl.startsWith(POST_AUTH_BRIDGE_PATH)
  );
}

export function buildPostAuthBridgeUrl(url: string, baseUrl: string): string {
  const callbackUrl = normalizeNextAuthCallbackTarget(url, baseUrl);

  if (shouldBypassPostAuthBridge(callbackUrl)) {
    return `${baseUrl}${callbackUrl}`;
  }

  const params = new URLSearchParams({ callbackUrl });
  return `${baseUrl}${POST_AUTH_BRIDGE_PATH}?${params.toString()}`;
}

export const STRICT_TRANSPORT_SECURITY_HEADER = "Strict-Transport-Security";
export const CONTENT_SECURITY_POLICY_HEADER = "Content-Security-Policy";
export const X_FRAME_OPTIONS_HEADER = "X-Frame-Options";
export const REFERRER_POLICY_HEADER = "Referrer-Policy";
export const X_CONTENT_TYPE_OPTIONS_HEADER = "X-Content-Type-Options";
export const CACHE_CONTROL_HEADER = "Cache-Control";
export const PRAGMA_HEADER = "Pragma";
export const NONCE_HEADER = "x-nonce";

type ContentSecurityPolicyOptions = {
  nonce?: string;
  isDevelopment?: boolean;
};

function buildScriptSrcDirective(nonce: string | undefined, isDevelopment: boolean) {
  const directives = ["'self'"];
  if (nonce) {
    directives.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  }
  if (isDevelopment) {
    directives.push("'unsafe-eval'");
  }
  return `script-src ${directives.join(" ")}`;
}

export function buildContentSecurityPolicy({
  nonce,
  isDevelopment = process.env.NODE_ENV === "development",
}: ContentSecurityPolicyOptions = {}) {
  return [
    "default-src 'self'",
    buildScriptSrcDirective(nonce, isDevelopment),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ") + ";";
}

export const GLOBAL_SECURITY_HEADERS = {
  [STRICT_TRANSPORT_SECURITY_HEADER]: "max-age=31536000; includeSubDomains; preload",
  [CONTENT_SECURITY_POLICY_HEADER]: buildContentSecurityPolicy(),
  [X_FRAME_OPTIONS_HEADER]: "DENY",
  [REFERRER_POLICY_HEADER]: "strict-origin-when-cross-origin",
  [X_CONTENT_TYPE_OPTIONS_HEADER]: "nosniff",
} as const;

export const SENSITIVE_CACHE_CONTROL_DIRECTIVES = ["no-store", "no-cache", "must-revalidate"] as const;

export function applySecurityHeaders<T extends Response>(response: T, nonce?: string): T {
  for (const [header, value] of Object.entries(GLOBAL_SECURITY_HEADERS)) {
    response.headers.set(header, value);
  }
  response.headers.set(CONTENT_SECURITY_POLICY_HEADER, buildContentSecurityPolicy({ nonce }));
  return response;
}

function mergeCacheControl(existingValue: string | null) {
  const directives = new Map<string, string>();

  for (const directive of existingValue?.split(",") ?? []) {
    const trimmed = directive.trim();
    if (!trimmed) continue;
    directives.set(trimmed.toLowerCase(), trimmed);
  }

  for (const directive of SENSITIVE_CACHE_CONTROL_DIRECTIVES) {
    directives.set(directive, directive);
  }

  return Array.from(directives.values()).join(", ");
}

export function applySensitiveNoCacheHeaders<T extends Response>(response: T): T {
  response.headers.set(CACHE_CONTROL_HEADER, mergeCacheControl(response.headers.get(CACHE_CONTROL_HEADER)));
  response.headers.set(PRAGMA_HEADER, "no-cache");
  return response;
}

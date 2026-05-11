type SameSitePolicy = "lax" | "strict";

type CookiePolicy = {
  name: string;
  options: {
    httpOnly: true;
    path: "/";
    sameSite: SameSitePolicy;
    secure: boolean;
    maxAge?: number;
  };
};

type AuthCookiePolicies = {
  sessionToken: CookiePolicy;
  callbackUrl: CookiePolicy;
  csrfToken: CookiePolicy;
  pkceCodeVerifier: CookiePolicy;
  state: CookiePolicy;
  nonce: CookiePolicy;
};

function getAuthCookiePrefix(secure: boolean) {
  return secure ? "__Host-" : "";
}

function buildCookiePolicy(name: string, secure: boolean, sameSite: SameSitePolicy, maxAge?: number): CookiePolicy {
  return {
    name,
    options: {
      httpOnly: true,
      path: "/",
      sameSite,
      secure,
      ...(maxAge === undefined ? {} : { maxAge }),
    },
  };
}

export function shouldUseSecureAuthCookies() {
  const authUrl = process.env.NEXTAUTH_URL ?? process.env.AUTH_URL;
  if (authUrl) {
    try {
      return new URL(authUrl).protocol === "https:";
    } catch {
      return authUrl.startsWith("https://");
    }
  }
  return Boolean(process.env.VERCEL);
}

export function getSessionCookieName() {
  return `${getAuthCookiePrefix(shouldUseSecureAuthCookies())}next-auth.session-token`;
}

export function getAuthCookiePolicies(): AuthCookiePolicies {
  const secure = shouldUseSecureAuthCookies();
  const prefix = getAuthCookiePrefix(secure);

  return {
    sessionToken: buildCookiePolicy(`${prefix}next-auth.session-token`, secure, "strict"),
    callbackUrl: buildCookiePolicy(`${prefix}next-auth.callback-url`, secure, "lax"),
    csrfToken: buildCookiePolicy(`${prefix}next-auth.csrf-token`, secure, "strict"),
    pkceCodeVerifier: buildCookiePolicy(`${prefix}next-auth.pkce.code_verifier`, secure, "lax", 60 * 15),
    state: buildCookiePolicy(`${prefix}next-auth.state`, secure, "lax", 60 * 15),
    nonce: buildCookiePolicy(`${prefix}next-auth.nonce`, secure, "lax"),
  };
}

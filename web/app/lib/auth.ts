import AzureADProvider from "next-auth/providers/azure-ad";
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";
import { getAuthCookiePoliciesAsync } from "./auth-cookies";
import { getBootScopedAuthSecret } from "./auth-secret";
import { buildPostAuthBridgeUrl } from "./callback-url";
import { clearDelegatedAuthState, saveDelegatedAuthState } from "./delegated-auth-store";
import { getRuntimeEnv, requireRuntimeEnv } from "./runtime-env";

type RequireAuthResult = {
  session: any;
  groups: string[];
};

let requireUserOverride: (() => Promise<RequireAuthResult>) | null = null;
let requireAdminOverride: (() => Promise<RequireAuthResult>) | null = null;

async function getAuthEnv() {
  const tenantId = await requireRuntimeEnv("ENTRA_TENANT_ID");
  const clientId = await requireRuntimeEnv("ENTRA_CLIENT_ID");
  const clientSecret = await requireRuntimeEnv("ENTRA_CLIENT_SECRET");
  return { tenantId, clientId, clientSecret };
}

const AUTHORIZATION_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
];

const TOKEN_EXCHANGE_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
];

function decodeJwtPayload(token?: string): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  try {
    const decoded = Buffer.from(payload, "base64").toString("utf-8");
    return JSON.parse(decoded);
  } catch {
    return null;
  }
}

export async function getAuthOptions(): Promise<NextAuthOptions> {
  const { tenantId, clientId, clientSecret } = await getAuthEnv();
  return {
    secret: getBootScopedAuthSecret(),
    providers: [
      AzureADProvider({
        tenantId,
        clientId,
        clientSecret,
        checks: ["pkce", "state"],
        idToken: true,
        authorization: {
          params: {
            scope: AUTHORIZATION_SCOPES.join(" "),
          },
        },
        token: {
          async request({ client, provider, params, checks }) {
            const tokens = await client.callback(provider.callbackUrl, params, checks, {
              exchangeBody: {
                scope: TOKEN_EXCHANGE_SCOPES.join(" "),
              },
            });
            return { tokens };
          },
        },
        profile(profile) {
          return {
            id: profile.oid || profile.sub,
            name: profile.name,
            email: profile.preferred_username || profile.email,
            image: null,
            oid: profile.oid,
            upn: profile.preferred_username,
            groups: profile.groups || [],
          } as any;
        },
      }),
    ],
    session: { strategy: "jwt" },
    cookies: await getAuthCookiePoliciesAsync(),
    pages: {
      signIn: "/signin/account",
      signOut: "/signout",
    },
    callbacks: {
      async jwt({ token, account, profile }) {
        if (profile) {
          token.oid = (profile as any).oid;
          token.upn = (profile as any).upn;
          token.groups = (profile as any).groups || [];
        }
        if (account?.id_token) {
          const payload = decodeJwtPayload(account.id_token);
          if (payload?.groups && Array.isArray(payload.groups)) {
            token.groups = payload.groups;
          }
          if (payload?.oid) {
            token.oid = payload.oid;
          }
          if (payload?.preferred_username) {
            token.upn = payload.preferred_username;
          }
        }
        if (account?.refresh_token || account?.access_token) {
          saveDelegatedAuthState({
            oid: typeof token.oid === "string" ? token.oid : null,
            upn: typeof token.upn === "string" ? token.upn : null,
            accessToken: typeof account.access_token === "string" ? account.access_token : null,
            accessTokenExpiresAt: typeof account.expires_at === "number" ? account.expires_at * 1000 : null,
            refreshToken: typeof account.refresh_token === "string" ? account.refresh_token : null,
            scope: typeof account.scope === "string" ? account.scope : null,
          });
        }
        return token;
      },
      async session({ session, token }) {
        (session as any).groups = token.groups || [];
        if (session.user) {
          (session.user as any).oid = token.oid;
          (session.user as any).upn = token.upn;
          (session.user as any).groups = token.groups || [];
        }
        return session;
      },
      async redirect({ url, baseUrl }) {
        return buildPostAuthBridgeUrl(url, baseUrl);
      },
    },
    events: {
      async signOut(message) {
        const token = (message as any)?.token;
        const session = (message as any)?.session;
        const oid =
          typeof token?.oid === "string"
            ? token.oid
            : typeof session?.user?.oid === "string"
              ? session.user.oid
              : null;
        const upn =
          typeof token?.upn === "string"
            ? token.upn
            : typeof session?.user?.upn === "string"
              ? session.user.upn
              : typeof session?.user?.email === "string"
                ? session.user.email
                : null;

        clearDelegatedAuthState(oid, upn);
      },
    },
  };
}

export async function getSession() {
  return getServerSession(await getAuthOptions());
}

export function getGroupsFromSession(session: any): string[] {
  return (session?.groups as string[]) || (session?.user?.groups as string[]) || [];
}

export async function isAdmin(groups: string[]) {
  const adminGroup = await getRuntimeEnv("ADMIN_GROUP_ID");
  return adminGroup ? groups.includes(adminGroup) : false;
}

export async function isUser(groups: string[]) {
  const userGroup = await getRuntimeEnv("USER_GROUP_ID");
  const adminGroup = await getRuntimeEnv("ADMIN_GROUP_ID");
  if (adminGroup && groups.includes(adminGroup)) return true;
  return userGroup ? groups.includes(userGroup) : false;
}

export async function requireUser() {
  if (requireUserOverride) {
    return requireUserOverride();
  }
  const session = await getSession();
  const groups = getGroupsFromSession(session);
  if (!session || !(await isUser(groups))) {
    throw new Error("unauthorized");
  }
  return { session, groups };
}

export async function requireAdmin() {
  if (requireAdminOverride) {
    return requireAdminOverride();
  }
  const session = await getSession();
  const groups = getGroupsFromSession(session);
  if (!session || !(await isAdmin(groups))) {
    throw new Error("forbidden");
  }
  return { session, groups };
}

export function setRequireAdminForTests(override: (() => Promise<RequireAuthResult>) | null) {
  requireAdminOverride = override;
}

export function setRequireUserForTests(override: (() => Promise<RequireAuthResult>) | null) {
  requireUserOverride = override;
}

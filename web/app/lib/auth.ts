import AzureADProvider from "next-auth/providers/azure-ad";
import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";

type RequireAuthResult = {
  session: any;
  groups: string[];
};

let requireAdminOverride: (() => Promise<RequireAuthResult>) | null = null;

function getAuthEnv() {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("ENTRA_TENANT_ID/ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET must be set");
  }
  return { tenantId, clientId, clientSecret };
}

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

export function getAuthOptions(): NextAuthOptions {
  const { tenantId, clientId, clientSecret } = getAuthEnv();
  return {
    providers: [
      AzureADProvider({
        tenantId,
        clientId,
        clientSecret,
        authorization: {
          params: {
            scope: ["openid", "profile", "email"].join(" "),
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
          token.idToken = account.id_token;
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
        if (account?.access_token) {
          token.accessToken = account.access_token;
        }
        return token;
      },
      async session({ session, token }) {
        (session as any).accessToken = token.accessToken;
        (session as any).groups = token.groups || [];
        if (session.user) {
          (session.user as any).oid = token.oid;
          (session.user as any).upn = token.upn;
          (session.user as any).groups = token.groups || [];
        }
        return session;
      },
    },
  };
}

export async function getSession() {
  return getServerSession(getAuthOptions());
}

export function getGroupsFromSession(session: any): string[] {
  return (session?.groups as string[]) || (session?.user?.groups as string[]) || [];
}

export function isAdmin(groups: string[]) {
  const adminGroup = process.env.ADMIN_GROUP_ID;
  return adminGroup ? groups.includes(adminGroup) : false;
}

export function isUser(groups: string[]) {
  const userGroup = process.env.USER_GROUP_ID;
  const adminGroup = process.env.ADMIN_GROUP_ID;
  if (adminGroup && groups.includes(adminGroup)) return true;
  return userGroup ? groups.includes(userGroup) : false;
}

export async function requireUser() {
  const session = await getSession();
  const groups = getGroupsFromSession(session);
  if (!session || !isUser(groups)) {
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
  if (!session || !isAdmin(groups)) {
    throw new Error("forbidden");
  }
  return { session, groups };
}

export function setRequireAdminForTests(override: (() => Promise<RequireAuthResult>) | null) {
  requireAdminOverride = override;
}

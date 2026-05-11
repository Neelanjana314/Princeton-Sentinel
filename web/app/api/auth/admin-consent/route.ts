import { NextResponse } from "next/server";
import { getGroupsFromSession, getSession, isAdmin } from "@/app/lib/auth";
import { sanitizeCallbackUrl } from "@/app/lib/callback-url";
import { getPublicRequestOrigin } from "@/app/lib/request-origin";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import { requireRuntimeEnv } from "@/app/lib/runtime-env";

export const dynamic = "force-dynamic";

const CONSENT_SCOPES = [
  "https://graph.microsoft.com/Directory.Read.All",
  "https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke",
];

async function getRequiredEnv() {
  const tenantId = (await requireRuntimeEnv("ENTRA_TENANT_ID")).trim();
  const clientId = (await requireRuntimeEnv("ENTRA_CLIENT_ID")).trim();
  const nextAuthUrl = (await requireRuntimeEnv("NEXTAUTH_URL")).trim().replace(/\/+$/, "");
  if (!tenantId || !clientId || !nextAuthUrl) {
    throw new Error("ENTRA_TENANT_ID, ENTRA_CLIENT_ID, and NEXTAUTH_URL must be set");
  }
  return { tenantId, clientId, nextAuthUrl };
}

function encodeState(callbackUrl: string) {
  return Buffer.from(JSON.stringify({ callbackUrl }), "utf8").toString("base64url");
}

const getHandler = async function GET(req: Request) {
  const session = await getSession();
  const groups = getGroupsFromSession(session);
  if (!session) {
    return NextResponse.redirect(new URL("/signin/account", req.url));
  }
  if (!(await isAdmin(groups))) {
    return NextResponse.redirect(new URL("/forbidden", req.url));
  }

  const { tenantId, clientId, nextAuthUrl } = await getRequiredEnv();
  const requestUrl = new URL(req.url);
  const callbackUrl = sanitizeCallbackUrl(requestUrl.searchParams.get("callbackUrl"));
  const redirectUri = `${getPublicRequestOrigin(req, nextAuthUrl)}/api/auth/admin-consent/callback`;
  const consentUrl = new URL(`https://login.microsoftonline.com/${tenantId}/v2.0/adminconsent`);
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("scope", CONSENT_SCOPES.join(" "));
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("state", encodeState(callbackUrl));

  return NextResponse.redirect(consentUrl);
};

export const GET = withApiRequestTiming("/api/auth/admin-consent", getHandler);

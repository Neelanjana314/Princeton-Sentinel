import { NextResponse } from "next/server";
import { sanitizeCallbackUrl } from "@/app/lib/callback-url";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

function decodeState(value: string | null): string {
  if (!value) {
    return "/dashboard/agents/agent-access-control";
  }

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const payload = JSON.parse(decoded) as { callbackUrl?: string };
    return sanitizeCallbackUrl(payload.callbackUrl);
  } catch {
    return "/dashboard/agents/agent-access-control";
  }
}

const getHandler = async function GET(req: Request) {
  const requestUrl = new URL(req.url);
  const destination = new URL(decodeState(requestUrl.searchParams.get("state")), req.url);
  const adminConsent = requestUrl.searchParams.get("admin_consent");
  const error = requestUrl.searchParams.get("error");

  if (adminConsent && adminConsent.toLowerCase() === "true") {
    destination.searchParams.set("adminConsent", "granted");
  } else if (error) {
    destination.searchParams.set("adminConsent", "failed");
    destination.searchParams.set("adminConsentError", error);
  }

  return NextResponse.redirect(destination);
};

export const GET = withApiRequestTiming("/api/auth/admin-consent/callback", getHandler);

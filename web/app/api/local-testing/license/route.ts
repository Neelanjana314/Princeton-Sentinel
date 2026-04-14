import { NextResponse } from "next/server";

import { requireUser } from "@/app/lib/auth";
import { writeAuditEvent } from "@/app/lib/audit";
import { sanitizeCallbackUrl } from "@/app/lib/callback-url";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { setEmulatedLicenseEnabled } from "@/app/lib/local-testing-state";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import { isLocalDockerDeployment } from "@/app/lib/runtime";

export const dynamic = "force-dynamic";

function redirectToCallback(callbackUrl: string) {
  const location = sanitizeCallbackUrl(callbackUrl);
  return new NextResponse(null, { status: 303, headers: { Location: location } });
}

function parseBoolean(value: FormDataEntryValue | null) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "f", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return null;
}

const postHandler = async function POST(req: Request) {
  const { session } = await requireUser();
  if (!isLocalDockerDeployment()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const form = await req.formData();
  const csrfToken = typeof form.get("csrf_token") === "string" ? String(form.get("csrf_token")) : null;
  const callbackUrl = typeof form.get("callbackUrl") === "string" ? String(form.get("callbackUrl")) : "/dashboard";
  const emulateLicenseEnabled = parseBoolean(form.get("emulateLicenseEnabled"));

  const csrfValidation = validateCsrfRequest(req, undefined, csrfToken);
  if (!csrfValidation.ok) {
    return redirectToCallback(callbackUrl);
  }
  if (emulateLicenseEnabled === null) {
    return NextResponse.json({ error: "emulate_license_enabled_required" }, { status: 400 });
  }

  await setEmulatedLicenseEnabled(emulateLicenseEnabled);
  await writeAuditEvent({
    action: "local_testing_license_emulation_updated",
    entityType: "local_testing_state",
    entityId: "default",
    actor: {
      oid: (session.user as any)?.oid || null,
      upn: (session.user as any)?.upn || null,
      name: session.user?.name || null,
    },
    details: {
      emulate_license_enabled: emulateLicenseEnabled,
    },
  });

  return redirectToCallback(callbackUrl);
};

export const POST = withApiRequestTiming("/api/local-testing/license", postHandler);

import { NextResponse } from "next/server";

import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { writeAuditEvent } from "@/app/lib/audit";
import {
  activateLicenseArtifact,
  clearActiveLicenseArtifact,
  insertLicenseArtifact,
  summarizeLicenseArtifactText,
  getCurrentLicenseSummary,
} from "@/app/lib/license";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

function redirectWithParams(target: string, params: Record<string, string>) {
  const url = new URL(target, "http://localhost");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextResponse(null, { status: 303, headers: { Location: `${url.pathname}${url.search}` } });
}

function jsonError(error: string, status: number, details?: Record<string, unknown>) {
  return NextResponse.json({ error, ...details }, { status });
}

async function readLicenseRequest(req: Request): Promise<{
  bodyType: "json" | "form" | "none";
  intent: string | null;
  text: string | null;
  csrfToken: string | null;
  invalidJson: boolean;
}> {
  const contentType = (req.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      const body = await req.json();
      const text = typeof body?.licenseText === "string" ? body.licenseText : null;
      const intent = typeof body?.intent === "string" ? body.intent : null;
      const csrfToken = typeof body?.csrf_token === "string" ? body.csrf_token : null;
      return { bodyType: "json", intent, text, csrfToken, invalidJson: false };
    } catch {
      return { bodyType: "json", intent: null, text: null, csrfToken: null, invalidJson: true };
    }
  }

  if (contentType.includes("form")) {
    const form = await req.formData();
    const intent = typeof form.get("intent") === "string" ? String(form.get("intent")) : null;
    const csrfToken = typeof form.get("csrf_token") === "string" ? String(form.get("csrf_token")) : null;
    const file = form.get("license_file");
    if (file instanceof File) {
      const text = await file.text();
      return { bodyType: "form", intent, text: text || null, csrfToken, invalidJson: false };
    }
    const text = typeof form.get("license_text") === "string" ? String(form.get("license_text")) : null;
    return { bodyType: "form", intent, text, csrfToken, invalidJson: false };
  }

  return { bodyType: "none", intent: null, text: null, csrfToken: null, invalidJson: false };
}

const getHandler = async function GET() {
  await requireAdmin();
  const summary = await getCurrentLicenseSummary();
  return NextResponse.json(summary);
};

const postHandler = async function POST(req: Request) {
  const { session } = await requireAdmin();
  const actor = {
    oid: (session.user as any)?.oid || null,
    upn: (session.user as any)?.upn || null,
    name: session.user?.name || null,
  };

  const payload = await readLicenseRequest(req);
  if (payload.invalidJson) {
    return jsonError("invalid_json_body", 400);
  }
  const csrfValidation = validateCsrfRequest(req, undefined, payload.csrfToken);
  const csrfError = "error" in csrfValidation ? csrfValidation.error : null;
  if (csrfError) {
    if (payload.bodyType === "form") {
      return redirectWithParams("/license", { error: csrfError });
    }
    return jsonError(csrfError, 403);
  }
  if (payload.intent === "clear") {
    await clearActiveLicenseArtifact();
    await writeAuditEvent({
      action: "license_artifact_cleared",
      entityType: "license_slot",
      entityId: "default",
      actor,
      details: {
        reason: "demo_remove",
      },
    });

    if (payload.bodyType === "form") {
      return redirectWithParams("/license", { cleared: "1" });
    }

    return NextResponse.json({ ok: true, cleared: true });
  }
  if (!payload.text || !payload.text.trim()) {
    if (payload.bodyType === "form") {
      return redirectWithParams("/license", { error: "license_file_required" });
    }
    return jsonError("license_file_required", 400);
  }

  const { artifactId, inspection } = await insertLicenseArtifact({
    rawLicenseText: payload.text,
    actor,
  });

  const summary = await summarizeLicenseArtifactText({
    rawLicenseText: payload.text,
    artifactId,
    uploadedBy: actor,
  });
  await activateLicenseArtifact(artifactId);
  await writeAuditEvent({
    action: "license_artifact_activated",
    entityType: "license_artifact",
    entityId: artifactId,
    actor,
    details: {
      license_id: summary.payload?.license_id || null,
      tenant_id: summary.payload?.tenant_id || null,
      license_type: summary.payload?.license_type || null,
      sha256: summary.sha256,
      status: summary.status,
      verification_status: summary.verificationStatus,
      error: summary.verificationError || inspection.verificationError,
    },
  });

  if (payload.bodyType === "form") {
    return redirectWithParams("/license", { uploaded: "1", status: summary.status });
  }

  return NextResponse.json({ ok: true, artifact_id: artifactId, summary }, { status: 201 });
};

export const GET = withApiRequestTiming("/api/license", getHandler);
export const POST = withApiRequestTiming("/api/license", postHandler);

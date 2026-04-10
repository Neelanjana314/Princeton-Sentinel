import { NextResponse } from "next/server";
import { query } from "@/app/lib/db";
import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { writeAuditEvent } from "@/app/lib/audit";
import { LicenseFeatureError, requireLicenseFeature } from "@/app/lib/license";
import { getNonEmptyString, parseBooleanInput, parseRequestBody } from "@/app/lib/request-body";
import { withApiRequestTiming } from "@/app/lib/request-timing";
export const dynamic = "force-dynamic";

const getHandler = async function GET() {
  await requireAdmin();
  const rows = await query(
    `
    SELECT job_id, job_type, tenant_id, config, enabled
    FROM jobs
    ORDER BY job_type
    `
  );
  return NextResponse.json({ jobs: rows });
};

const postHandler = async function POST(req: Request) {
  const { session } = await requireAdmin();
  const parsed = await parseRequestBody(req);
  if (parsed.invalidJson) {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const body: any = parsed.body;
  const csrfValidation = validateCsrfRequest(req, body);
  const csrfError = "error" in csrfValidation ? csrfValidation.error : null;
  if (csrfError) {
    return NextResponse.json({ error: csrfError }, { status: 403 });
  }
  const action = body.action || "create";

  try {
    await requireLicenseFeature("job_control");
  } catch (err: unknown) {
    if (err instanceof LicenseFeatureError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  if (action === "create") {
    return NextResponse.json({ error: "job_creation_disabled" }, { status: 403 });
  }

  if (action === "toggle") {
    const jobId = getNonEmptyString(body.job_id);
    if (!jobId) {
      return NextResponse.json({ error: "job_id_required" }, { status: 400 });
    }
    const enabled = parseBooleanInput(body.enabled);
    if (enabled === null) {
      return NextResponse.json({ error: "enabled_boolean_required" }, { status: 400 });
    }
    const rows = await query<{ job_id: string }>(
      `
      UPDATE jobs
      SET enabled = $1
      WHERE job_id = $2
      RETURNING job_id
      `,
      [enabled, jobId]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "job_not_found" }, { status: 404 });
    }

    await writeAuditEvent({
      action: enabled ? "job_enabled" : "job_disabled",
      entityType: "job",
      entityId: jobId,
      actor: {
        oid: (session.user as any)?.oid,
        upn: (session.user as any)?.upn,
        name: session.user?.name || undefined,
      },
      details: {},
    });

    return new NextResponse(null, { status: 303, headers: { Location: "/admin/jobs" } });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
};

export const GET = withApiRequestTiming("/api/jobs", getHandler);
export const POST = withApiRequestTiming("/api/jobs", postHandler);

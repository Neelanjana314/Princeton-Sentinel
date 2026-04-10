import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { query } from "@/app/lib/db";
import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { writeAuditEvent } from "@/app/lib/audit";
import { LicenseFeatureError, requireLicenseFeature } from "@/app/lib/license";
import { isValidCronExpression } from "@/app/lib/cron";
import { getNonEmptyString, parseBooleanInput, parseRequestBody } from "@/app/lib/request-body";
import { withApiRequestTiming } from "@/app/lib/request-timing";
export const dynamic = "force-dynamic";

function parseOptionalTimestamp(raw: unknown): string | null | undefined {
  if (raw === undefined) return null;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (!value) return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function errorResponse(bodyType: "json" | "form" | "none", error: string, status: number) {
  if (bodyType === "form") {
    const url = new URL("/admin/jobs", "http://localhost");
    url.searchParams.set("error", error.slice(0, 200));
    url.searchParams.set("status", String(status));
    return new NextResponse(null, { status: 303, headers: { Location: `${url.pathname}${url.search}` } });
  }
  return NextResponse.json({ error }, { status });
}

const getHandler = async function GET() {
  await requireAdmin();
  const rows = await query(
    `
    SELECT schedule_id, job_id, cron_expr, next_run_at, enabled
    FROM job_schedules
    ORDER BY next_run_at
    `
  );
  return NextResponse.json({ schedules: rows });
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
    return errorResponse(parsed.bodyType, csrfError, 403);
  }
  const action = body.action || "create";

  try {
    await requireLicenseFeature("job_control");
  } catch (err: unknown) {
    if (err instanceof LicenseFeatureError) {
      return errorResponse(parsed.bodyType, err.message, 403);
    }
    throw err;
  }

  if (action === "create") {
    const scheduleId = randomUUID();
    const jobId = getNonEmptyString(body.job_id);
    const cronExpr = getNonEmptyString(body.cron_expr);
    if (!jobId || !cronExpr) {
      return NextResponse.json({ error: "job_id_and_cron_expr_required" }, { status: 400 });
    }
    if (!isValidCronExpression(cronExpr)) {
      return NextResponse.json({ error: "invalid_cron_expr" }, { status: 400 });
    }

    const existing = await query(
      `
      SELECT schedule_id
      FROM job_schedules
      WHERE job_id = $1
      LIMIT 1
      `,
      [jobId]
    );
    if (existing.length) {
      return NextResponse.json({ error: "schedule_exists_for_job", schedule_id: existing[0].schedule_id }, { status: 409 });
    }

    const nextRunAt = parseOptionalTimestamp(body.next_run_at);
    if (nextRunAt === undefined) {
      return NextResponse.json({ error: "invalid_next_run_at" }, { status: 400 });
    }

    try {
      await query(
        `
        INSERT INTO job_schedules (schedule_id, job_id, cron_expr, next_run_at, enabled)
        VALUES ($1, $2, $3, $4::timestamptz, $5)
        `,
        [scheduleId, jobId, cronExpr, nextRunAt, true]
      );
    } catch (err: any) {
      if (err?.code === "23505") {
        return NextResponse.json({ error: "schedule_exists_for_job" }, { status: 409 });
      }
      throw err;
    }

    await writeAuditEvent({
      action: "schedule_created",
      entityType: "job_schedule",
      entityId: scheduleId,
      actor: {
        oid: (session.user as any)?.oid,
        upn: (session.user as any)?.upn,
        name: session.user?.name || undefined,
      },
      details: { job_id: jobId, cron_expr: cronExpr },
    });

    return new NextResponse(null, { status: 303, headers: { Location: "/admin/jobs" } });
  }

  if (action === "toggle") {
    const scheduleId = getNonEmptyString(body.schedule_id);
    if (!scheduleId) {
      return NextResponse.json({ error: "schedule_id_required" }, { status: 400 });
    }
    const enabled = parseBooleanInput(body.enabled);
    if (enabled === null) {
      return NextResponse.json({ error: "enabled_boolean_required" }, { status: 400 });
    }
    const rows = await query<any>(
      `
      UPDATE job_schedules
      SET enabled = $1, next_run_at = NULL
      WHERE schedule_id = $2
      RETURNING schedule_id, job_id
      `,
      [enabled, scheduleId]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
    }

    await writeAuditEvent({
      action: enabled ? "schedule_enabled" : "schedule_disabled",
      entityType: "job_schedule",
      entityId: scheduleId,
      actor: {
        oid: (session.user as any)?.oid,
        upn: (session.user as any)?.upn,
        name: session.user?.name || undefined,
      },
      details: { job_id: rows[0].job_id },
    });

    return new NextResponse(null, { status: 303, headers: { Location: "/admin/jobs" } });
  }

  if (action === "update") {
    const scheduleId = getNonEmptyString(body.schedule_id);
    const cronExpr = getNonEmptyString(body.cron_expr);
    if (!scheduleId || !cronExpr) {
      return NextResponse.json({ error: "schedule_id_and_cron_expr_required" }, { status: 400 });
    }
    if (!isValidCronExpression(cronExpr)) {
      return NextResponse.json({ error: "invalid_cron_expr" }, { status: 400 });
    }

    const nextRunAt = parseOptionalTimestamp(body.next_run_at);
    if (nextRunAt === undefined) {
      return NextResponse.json({ error: "invalid_next_run_at" }, { status: 400 });
    }
    const enabled =
      body.enabled === undefined || body.enabled === null || body.enabled === ""
        ? null
        : parseBooleanInput(body.enabled);
    if (enabled === null && body.enabled !== undefined && body.enabled !== null && body.enabled !== "") {
      return NextResponse.json({ error: "enabled_boolean_required" }, { status: 400 });
    }

    const rows = await query<any>(
      `
      UPDATE job_schedules
      SET cron_expr = $1,
          next_run_at = $2::timestamptz,
          enabled = COALESCE($3::boolean, enabled)
      WHERE schedule_id = $4
      RETURNING schedule_id, job_id
      `,
      [cronExpr, nextRunAt, enabled, scheduleId]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
    }

    await writeAuditEvent({
      action: "schedule_updated",
      entityType: "job_schedule",
      entityId: scheduleId,
      actor: {
        oid: (session.user as any)?.oid,
        upn: (session.user as any)?.upn,
        name: session.user?.name || undefined,
      },
      details: {
        job_id: rows[0].job_id,
        cron_expr: cronExpr,
        next_run_at: nextRunAt,
        enabled,
      },
    });

    return new NextResponse(null, { status: 303, headers: { Location: "/admin/jobs" } });
  }

  if (action === "delete") {
    const scheduleId = getNonEmptyString(body.schedule_id);
    if (!scheduleId) {
      return NextResponse.json({ error: "schedule_id_required" }, { status: 400 });
    }

    const rows = await query<any>(
      `
      DELETE FROM job_schedules
      WHERE schedule_id = $1
      RETURNING schedule_id, job_id, cron_expr
      `,
      [scheduleId]
    );
    if (!rows.length) {
      return NextResponse.json({ error: "schedule_not_found" }, { status: 404 });
    }

    await writeAuditEvent({
      action: "schedule_deleted",
      entityType: "job_schedule",
      entityId: scheduleId,
      actor: {
        oid: (session.user as any)?.oid,
        upn: (session.user as any)?.upn,
        name: session.user?.name || undefined,
      },
      details: {
        job_id: rows[0].job_id,
        cron_expr: rows[0].cron_expr,
      },
    });

    return new NextResponse(null, { status: 303, headers: { Location: "/admin/jobs" } });
  }

  return NextResponse.json({ error: "unsupported_action" }, { status: 400 });
};

export const GET = withApiRequestTiming("/api/schedules", getHandler);
export const POST = withApiRequestTiming("/api/schedules", postHandler);

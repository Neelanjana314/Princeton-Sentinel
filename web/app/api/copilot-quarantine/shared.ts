import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { query } from "@/app/lib/db";
import { requireLicenseFeature, LicenseFeatureError } from "@/app/lib/license";
import { getNonEmptyString, parseRequestBody } from "@/app/lib/request-body";
import { evaluateCopilotQuarantineRoles, toggleCopilotQuarantine } from "@/app/lib/copilot-quarantine";

type RequestStatus = "success" | "forbidden" | "failed";

async function insertLog(input: {
  action: "quarantine" | "unquarantine";
  requestStatus: RequestStatus;
  actor: { oid?: string | null; upn?: string | null; name?: string | null };
  botId: string;
  botName: string | null;
  reason?: string | null;
  resultingIsQuarantined?: boolean | null;
  resultLastUpdateTimeUtc?: string | null;
  errorDetail?: string | null;
  details?: Record<string, any> | null;
}) {
  await query(
    `INSERT INTO agent_quarantine_log
       (action, request_status, actor_oid, actor_upn, actor_name, bot_id, bot_name,
        reason, resulting_is_quarantined, result_last_update_time_utc, error_detail, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      input.action,
      input.requestStatus,
      input.actor.oid || null,
      input.actor.upn || null,
      input.actor.name || null,
      input.botId,
      input.botName,
      input.reason ?? null,
      input.resultingIsQuarantined ?? null,
      input.resultLastUpdateTimeUtc ?? null,
      input.errorDetail ?? null,
      input.details ?? null,
    ]
  );
}

function getErrorStatus(error: unknown) {
  const message = error instanceof Error ? error.message : "copilot_quarantine_failed";
  if (/forbidden|consent|required|scope_missing|role/i.test(message)) {
    return 403;
  }
  if (/not_found|missing|required/i.test(message)) {
    return 400;
  }
  return 502;
}

export async function handleCopilotQuarantineAction(req: Request, action: "quarantine" | "unquarantine") {
  const { session } = await requireAdmin();
  const parsed = await parseRequestBody(req);
  if (parsed.invalidJson) {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }

  const body = parsed.body;
  const csrfValidation = validateCsrfRequest(req, body);
  const csrfError = "error" in csrfValidation ? csrfValidation.error : null;
  if (csrfError) {
    return NextResponse.json({ error: csrfError }, { status: 403 });
  }

  try {
    await requireLicenseFeature("job_control");
  } catch (error) {
    if (error instanceof LicenseFeatureError) {
      return NextResponse.json({ error: error.message, feature: error.featureKey }, { status: 403 });
    }
    throw error;
  }

  const botId = getNonEmptyString(body.botId);
  const botName = getNonEmptyString(body.botName) || botId;
  const reason = getNonEmptyString(body.reason);
  if (!botId) {
    return NextResponse.json({ error: "botId is required" }, { status: 400 });
  }
  if (!reason) {
    return NextResponse.json({ error: "reason is required" }, { status: 400 });
  }

  const actor = {
    oid: (session.user as any)?.oid || null,
    upn: (session.user as any)?.upn || null,
    name: session.user?.name || null,
  };

  const roleCheck = await evaluateCopilotQuarantineRoles(session);
  if (!roleCheck.allowed) {
    await insertLog({
      action,
      requestStatus: "forbidden",
      actor,
      botId,
      botName,
      reason,
      errorDetail: roleCheck.error || "copilot_quarantine_role_forbidden",
      details: { roleCheck },
    });
    return NextResponse.json({ error: roleCheck.error || "copilot_quarantine_role_forbidden" }, { status: 403 });
  }

  try {
    const row = await toggleCopilotQuarantine(session, action, botId, botName || botId);
    await insertLog({
      action,
      requestStatus: "success",
      actor,
      botId,
      botName: row.botName,
      reason,
      resultingIsQuarantined: row.isQuarantined,
      resultLastUpdateTimeUtc: row.lastUpdateTimeUtc,
      details: { state: row.state },
    });
    return NextResponse.json({ status: "ok", agent: row });
  } catch (error) {
    const message = error instanceof Error ? error.message : "copilot_quarantine_failed";
    await insertLog({
      action,
      requestStatus: getErrorStatus(error) === 403 ? "forbidden" : "failed",
      actor,
      botId,
      botName,
      reason,
      errorDetail: message,
      details: { roleCheck },
    });
    return NextResponse.json({ error: message }, { status: getErrorStatus(error) });
  }
}

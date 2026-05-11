import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { query } from "@/app/lib/db";
import { writeAuditEvent } from "@/app/lib/audit";
import {
  fetchDataverseTable,
  getDataverseErrorResponse,
  patchDataverseRow,
} from "@/app/lib/dataverse";
import {
  callWorker,
  isWorkerTimeoutError,
  parseWorkerErrorText,
} from "@/app/lib/worker-api";
import { getNonEmptyString, parseRequestBody } from "@/app/lib/request-body";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import { getDvColumns, getDvEntitySet, type DvColumns } from "@/app/lib/dv-columns";
import { LicenseFeatureError, requireLicenseFeature } from "@/app/lib/license";
import { getRuntimeEnv } from "@/app/lib/runtime-env";

export const dynamic = "force-dynamic";

type DvRow = Record<string, any>;

async function getDvConfig() {
  const prefix = (await getRuntimeEnv("DATAVERSE_COLUMN_PREFIX")) || "";
  const cols = getDvColumns(prefix);
  const entitySet = getDvEntitySet((await getRuntimeEnv("DATAVERSE_TABLE_URL")) || "");
  const selectCols = [
    cols.id, cols.agentname, cols.username, cols.disableflag,
    cols.reason, cols.lastmodifiedby, cols.lastseeninsync, "modifiedon",
  ].join(",");
  return { entitySet, cols, selectCols };
}

function normalizeValue(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function mapDvRowToBlock(row: DvRow, cols: DvColumns) {
  return {
    id: row[cols.id] || `${row[cols.agentname] || ""}:${row[cols.username] || ""}`,
    dv_row_id: row[cols.id] || null,
    user_id: row[cols.username] || "",
    user_display_name: row[cols.username] || null,
    user_principal_name: row[cols.username] || null,
    bot_id: row[cols.agentname] || "",
    bot_name: row[cols.agentname] || null,
    block_scope: "agent" as const,
    blocked_by: row[cols.lastmodifiedby] || "unknown",
    blocked_at: row.modifiedon || row[cols.lastseeninsync] || new Date().toISOString(),
    block_reason: row[cols.reason] || null,
  };
}

async function fetchDataverseRows(entitySet: string, selectCols: string): Promise<DvRow[]> {
  return fetchDataverseTable(entitySet, { select: selectCols });
}

const getHandler = async function GET() {
  await requireAdmin();
  const { entitySet, cols, selectCols } = await getDvConfig();

  let rows: DvRow[];
  try {
    rows = await fetchDataverseRows(entitySet, selectCols);
  } catch (err: unknown) {
    const response = getDataverseErrorResponse(err, "dataverse_fetch_failed");
    return NextResponse.json(
      { error: response.error, dv_error_type: response.dv_error_type },
      { status: response.status }
    );
  }

  const [users, agents, registrations] = await Promise.all([
    query(
      `SELECT DISTINCT user_id, MAX(bot_name) AS last_agent
       FROM copilot_sessions
       WHERE deleted_at IS NULL AND user_id IS NOT NULL
       GROUP BY user_id
       ORDER BY user_id`
    ),
    query(
      `SELECT DISTINCT bot_id, bot_name
       FROM copilot_sessions
       WHERE deleted_at IS NULL AND bot_id IS NOT NULL
       GROUP BY bot_id, bot_name
       ORDER BY bot_name`
    ),
    query(
      `SELECT bot_id, bot_name, app_registration_id, disabled_at, disabled_by, disabled_reason
       FROM copilot_agent_registrations
       ORDER BY bot_name`
    ),
  ]);
  const blocks = rows
    .filter((row) => row[cols.disableflag] === true)
    .map((row) => mapDvRowToBlock(row, cols))
    .sort((a, b) => Date.parse(b.blocked_at) - Date.parse(a.blocked_at));

  return NextResponse.json({ blocks, users, agents, registrations });
};

const postHandler = async function POST(req: Request) {
  const { session } = await requireAdmin();
  try {
    await requireLicenseFeature("job_control");
  } catch (error) {
    if (error instanceof LicenseFeatureError) {
      return NextResponse.json(
        {
          error: error.message,
          feature: error.featureKey,
          license: error.summary,
        },
        { status: 403 }
      );
    }
    throw error;
  }
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
  const action = getNonEmptyString(body.action);
  const userId = getNonEmptyString(body.user_id);
  const botId = getNonEmptyString(body.bot_id);
  const botName = getNonEmptyString(body.bot_name) || botId;
  const userDisplayName = getNonEmptyString(body.user_display_name) || userId;
  const userPrincipalName = getNonEmptyString(body.user_principal_name) || userId;
  const blockScope = getNonEmptyString(body.block_scope) || "agent";
  const blockReason = getNonEmptyString(body.block_reason) || null;
  const unblockReason = getNonEmptyString(body.unblock_reason) || null;
  const dvRowId = getNonEmptyString(body.dv_row_id) || null;

  if (!action || !["block", "unblock", "disable-agent", "enable-agent", "register-agent"].includes(action)) {
    return NextResponse.json(
      { error: "action must be 'block', 'unblock', 'disable-agent', 'enable-agent', or 'register-agent'" },
      { status: 400 }
    );
  }

  const actor = {
    oid: (session.user as any)?.oid,
    upn: (session.user as any)?.upn,
    name: session.user?.name,
  };
  const adminUpn = actor.upn || actor.oid || "unknown";

  if (action === "register-agent") {
    if (!botId) {
      return NextResponse.json({ error: "bot_id is required" }, { status: 400 });
    }
    const appRegistrationId = getNonEmptyString(body.app_registration_id);
    if (!appRegistrationId) {
      return NextResponse.json({ error: "app_registration_id is required" }, { status: 400 });
    }
    const existing = await query(
      `SELECT bot_id FROM copilot_agent_registrations WHERE bot_id = $1`,
      [botId]
    );
    if (existing.length > 0) {
      return NextResponse.json({ error: "agent_already_registered" }, { status: 409 });
    }
    await query(
      `INSERT INTO copilot_agent_registrations (bot_id, bot_name, app_registration_id)
       VALUES ($1, $2, $3)`,
      [botId, botName, appRegistrationId]
    );
    await writeAuditEvent({
      action: "copilot_agent_registered",
      entityType: "copilot_agent",
      entityId: botId,
      actor,
      details: { bot_id: botId, bot_name: botName, app_registration_id: appRegistrationId },
    });
    return NextResponse.json({ status: "registered", bot_id: botId });
  }

  if (action === "disable-agent") {
    if (!botId) {
      return NextResponse.json({ error: "bot_id is required" }, { status: 400 });
    }
    const reason = getNonEmptyString(body.reason) || "";
    const workerResult = await callWorkerCA("/conditional-access/disable-agent", {
      bot_id: botId,
      reason,
      actor,
    });
    await writeAuditEvent({
      action: "copilot_agent_disabled",
      entityType: "copilot_agent",
      entityId: botId,
      actor,
      details: { bot_id: botId, reason, worker_success: workerResult.success, worker_error: workerResult.error },
    });
    if (!workerResult.success) {
      return NextResponse.json({ error: workerResult.error || "disable_failed" }, { status: 502 });
    }
    return NextResponse.json({ status: "disabled", bot_id: botId });
  }

  if (action === "enable-agent") {
    if (!botId) {
      return NextResponse.json({ error: "bot_id is required" }, { status: 400 });
    }
    const workerResult = await callWorkerCA("/conditional-access/enable-agent", {
      bot_id: botId,
      actor,
    });
    await writeAuditEvent({
      action: "copilot_agent_enabled",
      entityType: "copilot_agent",
      entityId: botId,
      actor,
      details: { bot_id: botId, worker_success: workerResult.success, worker_error: workerResult.error },
    });
    if (!workerResult.success) {
      return NextResponse.json({ error: workerResult.error || "enable_failed" }, { status: 502 });
    }
    return NextResponse.json({ status: "enabled", bot_id: botId });
  }

  if (!userId || !botId) {
    return NextResponse.json({ error: "user_id and bot_id are required" }, { status: 400 });
  }
  if (!dvRowId) {
    return NextResponse.json({ error: "dv_row_id is required" }, { status: 400 });
  }
  if (!["agent", "all"].includes(blockScope)) {
    return NextResponse.json({ error: "block_scope must be 'agent' or 'all'" }, { status: 400 });
  }

  const { entitySet: dvEntitySet, cols, selectCols } = await getDvConfig();
  let rows: DvRow[];
  try {
    rows = await fetchDataverseRows(dvEntitySet, selectCols);
  } catch (err: unknown) {
    const response = getDataverseErrorResponse(err, "dataverse_fetch_failed");
    return NextResponse.json(
      { error: response.error, dv_error_type: response.dv_error_type },
      { status: response.status }
    );
  }
  const dvRow = rows.find((row) => row[cols.id] === dvRowId);
  if (!dvRow) {
    return NextResponse.json({ error: "dv_row_not_found" }, { status: 404 });
  }

  const matchesActionTarget =
    normalizeValue(dvRow[cols.agentname]) === normalizeValue(botName || botId) &&
    normalizeValue(dvRow[cols.username]) === normalizeValue(userPrincipalName || userDisplayName || userId);

  if (!matchesActionTarget) {
    return NextResponse.json({ error: "dv_row_mismatch" }, { status: 409 });
  }

  if (action === "block") {
    if (dvRow[cols.disableflag] === true) {
      return NextResponse.json({ error: "user_already_blocked" }, { status: 409 });
    }

    try {
      await updateDvRow(dvRowId, dvEntitySet, {
        [cols.disableflag]: true,
        [cols.reason]: blockReason,
        [cols.lastmodifiedby]: adminUpn,
      });
    } catch (err: unknown) {
      const response = getDataverseErrorResponse(err, "dataverse_patch_failed");
      return NextResponse.json(
        { error: response.error, dv_error_type: response.dv_error_type },
        { status: response.status }
      );
    }

    await query(
      `INSERT INTO agent_access_revoke_log
         (action, admin_upn, admin_name, bot_id, bot_name, user_id, user_name, user_email, reason)
       VALUES ('block', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [adminUpn, actor.name || null, botId, botName, userId, userDisplayName, userPrincipalName || null, blockReason]
    );

    const workerResult = await callWorkerCA("/conditional-access/block", {
      user_id: userId,
      bot_id: botId,
      bot_name: botName,
      block_scope: blockScope,
      actor,
    });

    await writeAuditEvent({
      action: "copilot_user_blocked",
      entityType: "copilot_access_block",
      entityId: `${userId}:${botId}`,
      actor,
      details: {
        user_id: userId,
        bot_id: botId,
        block_scope: blockScope,
        worker_success: workerResult.success,
        worker_error: workerResult.error,
      },
    });

    return NextResponse.json({
      status: "blocked",
      dv_row_id: dvRowId,
      block_scope: blockScope,
      entra_synced: blockScope === "all" ? workerResult.success : null,
      entra_error: blockScope === "all" ? workerResult.error : null,
    });
  }

  if (dvRow[cols.disableflag] !== true) {
    return NextResponse.json({ error: "no_active_block_found" }, { status: 404 });
  }

  const workerResult = await callWorkerCA("/conditional-access/unblock", {
    user_id: userId,
    bot_id: botId,
    block_scope: blockScope,
    actor,
  });

  if (!workerResult.success && blockScope === "all") {
    await writeAuditEvent({
      action: "copilot_user_unblock_failed",
      entityType: "copilot_access_block",
      entityId: `${userId}:${botId}`,
      actor,
      details: {
        user_id: userId,
        bot_id: botId,
        block_scope: blockScope,
        worker_success: false,
        worker_error: workerResult.error,
      },
    });
    return NextResponse.json({ error: workerResult.error || "unblock_failed" }, { status: 502 });
  }

  try {
    await updateDvRow(dvRowId, dvEntitySet, {
      [cols.disableflag]: false,
      [cols.reason]: unblockReason,
      [cols.lastmodifiedby]: adminUpn,
    });
  } catch (err: unknown) {
    const response = getDataverseErrorResponse(err, "dataverse_patch_failed");
    return NextResponse.json(
      { error: response.error, dv_error_type: response.dv_error_type },
      { status: response.status }
    );
  }

  await query(
    `INSERT INTO agent_access_revoke_log
       (action, admin_upn, admin_name, bot_id, bot_name, user_id, user_name, user_email, reason)
     VALUES ('unblock', $1, $2, $3, $4, $5, $6, $7, $8)`,
    [adminUpn, actor.name || null, botId, botName, userId, userDisplayName, userPrincipalName || null, unblockReason]
  );

  await writeAuditEvent({
    action: "copilot_user_unblocked",
    entityType: "copilot_access_block",
    entityId: `${userId}:${botId}`,
    actor,
    details: {
      user_id: userId,
      bot_id: botId,
      block_scope: blockScope,
      worker_success: workerResult.success,
      worker_error: workerResult.error,
    },
  });

  return NextResponse.json({
    status: "unblocked",
    dv_row_id: dvRowId,
    block_scope: blockScope,
    entra_synced: blockScope === "all" ? workerResult.success : null,
    entra_error: blockScope === "all" ? workerResult.error : null,
  });
};

async function updateDvRow(rowId: string, entitySet: string, data: Record<string, unknown>): Promise<void> {
  await patchDataverseRow(entitySet, rowId, data);
}

async function callWorkerCA(
  path: string,
  payload: Record<string, any>
): Promise<{ success: boolean; error?: string }> {
  try {
    const { res, text } = await callWorker(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const error = parseWorkerErrorText(text);
      return { success: false, error };
    }
    return { success: true };
  } catch (err: unknown) {
    if (isWorkerTimeoutError(err)) {
      return { success: false, error: "worker_request_timeout" };
    }
    const message = err instanceof Error ? err.message : "worker_request_failed";
    return { success: false, error: message };
  }
}

export const GET = withApiRequestTiming("/api/agents/access-blocks", getHandler);
export const POST = withApiRequestTiming("/api/agents/access-blocks", postHandler);

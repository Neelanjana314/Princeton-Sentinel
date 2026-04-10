import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { query } from "@/app/lib/db";
import { writeAuditEvent } from "@/app/lib/audit";
import {
  callWorker,
  callWorkerJson,
  isWorkerTimeoutError,
  parseWorkerErrorText,
} from "@/app/lib/worker-api";
import { getNonEmptyString, parseRequestBody } from "@/app/lib/request-body";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

const DV_ENTITY_SET = "cr6c3_table11s";
const DV_SELECT_COLS = [
  "cr6c3_table11id",
  "cr6c3_agentname",
  "cr6c3_username",
  "cr6c3_disableflagcopilot",
  "cr6c3_copilotflagchangereason",
  "cr6c3_userlastmodifiedby",
  "cr6c3_lastseeninsync",
  "modifiedon",
].join(",");

type DvRow = {
  cr6c3_table11id?: string;
  cr6c3_agentname?: string | null;
  cr6c3_username?: string | null;
  cr6c3_disableflagcopilot?: boolean | null;
  cr6c3_copilotflagchangereason?: string | null;
  cr6c3_userlastmodifiedby?: string | null;
  cr6c3_lastseeninsync?: string | null;
  modifiedon?: string | null;
};

function normalizeValue(value: string | null | undefined): string {
  return (value || "").trim().toLowerCase();
}

function mapDvRowToBlock(row: DvRow) {
  return {
    id: row.cr6c3_table11id || `${row.cr6c3_agentname || ""}:${row.cr6c3_username || ""}`,
    dv_row_id: row.cr6c3_table11id || null,
    user_id: row.cr6c3_username || "",
    user_display_name: row.cr6c3_username || null,
    user_principal_name: row.cr6c3_username || null,
    bot_id: row.cr6c3_agentname || "",
    bot_name: row.cr6c3_agentname || null,
    block_scope: "agent" as const,
    blocked_by: row.cr6c3_userlastmodifiedby || "unknown",
    blocked_at: row.modifiedon || row.cr6c3_lastseeninsync || new Date().toISOString(),
    block_reason: row.cr6c3_copilotflagchangereason || null,
  };
}

async function fetchDataverseRows(): Promise<DvRow[]> {
  const qs = new URLSearchParams({ entity_set: DV_ENTITY_SET, select: DV_SELECT_COLS });
  const data = await callWorkerJson(`/dataverse/table?${qs.toString()}`);
  return Array.isArray(data?.rows) ? data.rows : [];
}

const getHandler = async function GET() {
  await requireAdmin();

  const [rows, users, agents, registrations] = await Promise.all([
    fetchDataverseRows(),
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
    .filter((row) => row.cr6c3_disableflagcopilot === true)
    .map(mapDvRowToBlock)
    .sort((a, b) => Date.parse(b.blocked_at) - Date.parse(a.blocked_at));

  return NextResponse.json({ blocks, users, agents, registrations });
};

const postHandler = async function POST(req: Request) {
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

  const rows = await fetchDataverseRows();
  const dvRow = rows.find((row) => row.cr6c3_table11id === dvRowId);
  if (!dvRow) {
    return NextResponse.json({ error: "dv_row_not_found" }, { status: 404 });
  }

  const matchesActionTarget =
    normalizeValue(dvRow.cr6c3_agentname) === normalizeValue(botName || botId) &&
    normalizeValue(dvRow.cr6c3_username) === normalizeValue(userPrincipalName || userDisplayName || userId);

  if (!matchesActionTarget) {
    return NextResponse.json({ error: "dv_row_mismatch" }, { status: 409 });
  }

  if (action === "block") {
    if (dvRow.cr6c3_disableflagcopilot === true) {
      return NextResponse.json({ error: "user_already_blocked" }, { status: 409 });
    }

    await updateDvRow(dvRowId, {
      cr6c3_disableflagcopilot: true,
      cr6c3_copilotflagchangereason: blockReason,
      cr6c3_userlastmodifiedby: adminUpn,
    });

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

  if (dvRow.cr6c3_disableflagcopilot !== true) {
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

  await updateDvRow(dvRowId, {
    cr6c3_disableflagcopilot: false,
    cr6c3_copilotflagchangereason: unblockReason,
    cr6c3_userlastmodifiedby: adminUpn,
  });

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

async function updateDvRow(rowId: string, data: Record<string, unknown>): Promise<void> {
  try {
    const { res, text } = await callWorker("/dataverse/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_set: DV_ENTITY_SET, row_id: rowId, data }),
    });
    if (!res.ok) {
      throw new Error(parseWorkerErrorText(text));
    }
  } catch (err: unknown) {
    if (isWorkerTimeoutError(err)) {
      throw new Error("dataverse_patch_timeout");
    }
    const message = err instanceof Error ? err.message : "dataverse_patch_failed";
    throw new Error(message);
  }
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

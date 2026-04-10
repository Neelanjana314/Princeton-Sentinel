import { NextRequest, NextResponse } from "next/server";
import { requireUser, isAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { callWorkerJson } from "@/app/lib/worker-api";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

const ENTITY_SET = "cr6c3_table11s";
const SELECT_COLS =
  "cr6c3_table11id,cr6c3_agentname,cr6c3_username,cr6c3_disableflagcopilot,cr6c3_copilotflagchangereason,cr6c3_lastseeninsync,cr6c3_userlastmodifiedby,modifiedon,_modifiedby_value";

/**
 * GET /api/agents/agent-access-control
 * Fetches the agent-user table from Dataverse. Admin-only.
 */
async function getHandler(req: NextRequest) {
  const { groups } = await requireUser();
  if (!isAdmin(groups)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const qs = new URLSearchParams({ entity_set: ENTITY_SET, select: SELECT_COLS });

  try {
    const data = await callWorkerJson(`/dataverse/table?${qs.toString()}`);
    return NextResponse.json(data);
  } catch (err: any) {
    const status = err?.status || 502;
    const message = err?.bodyText || err?.message || "dataverse_fetch_failed";
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * POST /api/agents/agent-access-control
 * body: { row_id: string, data: Record<string, any> }
 * Patches a single Dataverse row. Admin-only.
 */
async function postHandler(req: NextRequest) {
  const { groups } = await requireUser();
  if (!isAdmin(groups)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json_body" }, { status: 400 });
  }
  const csrfValidation = validateCsrfRequest(req, body);
  const csrfError = "error" in csrfValidation ? csrfValidation.error : null;
  if (csrfError) {
    return NextResponse.json({ error: csrfError }, { status: 403 });
  }

  const row_id = (body?.row_id || "").trim();
  const data = body?.data;

  if (!row_id) return NextResponse.json({ error: "row_id is required" }, { status: 400 });
  if (!data || typeof data !== "object") return NextResponse.json({ error: "data is required" }, { status: 400 });

  try {
    const result = await callWorkerJson("/dataverse/patch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_set: ENTITY_SET, row_id, data }),
    });
    return NextResponse.json(result);
  } catch (err: any) {
    const status = err?.status || 502;
    const message = err?.bodyText || err?.message || "dataverse_patch_failed";
    return NextResponse.json({ error: message }, { status });
  }
}

export const GET = withApiRequestTiming("/api/agents/agent-access-control", getHandler);
export const POST = withApiRequestTiming("/api/agents/agent-access-control", postHandler);

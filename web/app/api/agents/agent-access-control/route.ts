import { NextRequest, NextResponse } from "next/server";
import { requireUser, isAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import {
  fetchDataverseTable,
  getDataverseErrorResponse,
  patchDataverseRow,
} from "@/app/lib/dataverse";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import { getDvColumns, getDvEntitySet } from "@/app/lib/dv-columns";

export const dynamic = "force-dynamic";

function getDvConfig() {
  const prefix = process.env.DATAVERSE_COLUMN_PREFIX || "";
  const cols = getDvColumns(prefix);
  const entitySet = getDvEntitySet(process.env.DATAVERSE_TABLE_URL || "");
  const selectCols = [
    cols.id, cols.agentname, cols.username, cols.disableflag,
    cols.reason, cols.lastseeninsync, cols.lastmodifiedby,
    cols.userdeleteflag, "modifiedon", "_modifiedby_value",
  ].join(",");
  return { entitySet, cols, selectCols };
}

function isUserDeleteFlagAllowed(value: unknown): boolean {
  if (typeof value === "number") return value === 4;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "4" || normalized === "allowed";
  }
  return false;
}

/**
 * GET /api/agents/agent-access-control
 * Fetches the agent-user table from Dataverse. Admin-only.
 */
async function getHandler(req: NextRequest) {
  const { groups } = await requireUser();
  if (!isAdmin(groups)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const { entitySet, cols, selectCols } = getDvConfig();

  try {
    const data = await fetchDataverseTable(entitySet, { select: selectCols });
    const rows = data.filter((row: Record<string, unknown>) => isUserDeleteFlagAllowed(row?.[cols.userdeleteflag]));
    return NextResponse.json({ rows, count: rows.length });
  } catch (err: unknown) {
    const response = getDataverseErrorResponse(err, "dataverse_fetch_failed");
    return NextResponse.json(
      { error: response.error, dv_error_type: response.dv_error_type },
      { status: response.status }
    );
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
    await patchDataverseRow(getDvConfig().entitySet, row_id, data);
    return NextResponse.json({ status: "updated" });
  } catch (err: unknown) {
    const response = getDataverseErrorResponse(err, "dataverse_patch_failed");
    return NextResponse.json(
      { error: response.error, dv_error_type: response.dv_error_type },
      { status: response.status }
    );
  }
}

export const GET = withApiRequestTiming("/api/agents/agent-access-control", getHandler);
export const POST = withApiRequestTiming("/api/agents/agent-access-control", postHandler);

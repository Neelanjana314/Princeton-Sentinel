import { NextResponse } from "next/server";
import { requireAdmin, requireUser } from "@/app/lib/auth";
import { LicenseFeatureError, requireLicenseFeature } from "@/app/lib/license";
import { graphDelete, graphGet } from "@/app/lib/graph";
import { withTransaction } from "@/app/lib/db";
import { writeAuditEvent } from "@/app/lib/audit";
import { writeRevokePermissionLog } from "@/app/lib/revoke-log";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

async function parseBody(req: Request) {
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return await req.json();
    } catch {
      return {};
    }
  }
  if (contentType.includes("form")) {
    const form = await req.formData();
    return Object.fromEntries(form.entries());
  }
  return {};
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return fallback;
}

function sanitizeReason(text: string, max = 240): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function actorFromSession(session: any): { oid?: string; upn?: string; name?: string } | null {
  const oid = (session?.user as any)?.oid;
  const upn = (session?.user as any)?.upn;
  const name = session?.user?.name;
  if (!oid && !upn && !name) return null;
  return { oid, upn, name };
}

async function safeWriteRevokeLog(params: {
  actor?: { oid?: string; upn?: string; name?: string } | null;
  driveId?: string | null;
  itemId?: string | null;
  permissionId?: string | null;
  outcome: "success" | "failed";
  failureReason?: string | null;
  warning?: string | null;
  details?: Record<string, any>;
}) {
  try {
    await writeRevokePermissionLog(params);
  } catch {
    // Best-effort logging only; never break revoke response.
  }
}

const getHandler = async function GET(req: Request) {
  await requireUser();
  const { searchParams } = new URL(req.url);
  const driveId = searchParams.get("driveId");
  const itemId = searchParams.get("itemId");
  if (!driveId || !itemId) {
    return NextResponse.json({ error: "driveId_and_itemId_required" }, { status: 400 });
  }

  try {
    const data = await graphGet(`/drives/${driveId}/items/${itemId}/permissions`);
    return NextResponse.json({ mode: "live", data });
  } catch (err: unknown) {
    return NextResponse.json({ error: getErrorMessage(err, "graph_get_permissions_failed") }, { status: 502 });
  }
};

const deleteHandler = async function DELETE(req: Request) {
  let session: any = null;
  let actor: { oid?: string; upn?: string; name?: string } | null = null;
  try {
    const auth = await requireAdmin();
    session = auth.session;
    actor = actorFromSession(session);
  } catch {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body: any = await parseBody(req);
  const { searchParams } = new URL(req.url);
  const driveId = body.driveId || searchParams.get("driveId");
  const itemId = body.itemId || searchParams.get("itemId");
  const permissionId = body.permissionId || searchParams.get("permissionId");

  if (!driveId || !itemId || !permissionId) {
    await safeWriteRevokeLog({
      actor,
      driveId: driveId ? String(driveId) : null,
      itemId: itemId ? String(itemId) : null,
      permissionId: permissionId ? String(permissionId) : null,
      outcome: "failed",
      failureReason: "driveId_itemId_permissionId_required",
      details: { stage: "validation" },
    });
    return NextResponse.json({ error: "driveId_itemId_permissionId_required" }, { status: 400 });
  }

  const normalizedDriveId = String(driveId);
  const normalizedItemId = String(itemId);
  const normalizedPermissionId = String(permissionId);
  const encodedPermissionId = encodeURIComponent(normalizedPermissionId);

  try {
    await requireLicenseFeature("permission_revoke");
  } catch (err: unknown) {
    if (err instanceof LicenseFeatureError) {
      await safeWriteRevokeLog({
        actor,
        driveId: normalizedDriveId,
        itemId: normalizedItemId,
        permissionId: normalizedPermissionId,
        outcome: "failed",
        failureReason: err.message,
        details: { stage: "license_gate" },
      });
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    throw err;
  }

  let permission: any = null;
  try {
    permission = await graphGet(`/drives/${normalizedDriveId}/items/${normalizedItemId}/permissions/${encodedPermissionId}`);
  } catch (err: unknown) {
    const errorMessage = getErrorMessage(err, "graph_get_permission_failed");
    await safeWriteRevokeLog({
      actor,
      driveId: normalizedDriveId,
      itemId: normalizedItemId,
      permissionId: normalizedPermissionId,
      outcome: "failed",
      failureReason: sanitizeReason(errorMessage),
      details: { stage: "graph_get_permission" },
    });
    return NextResponse.json({ error: errorMessage }, { status: 502 });
  }

  if (permission?.inheritedFrom) {
    await safeWriteRevokeLog({
      actor,
      driveId: normalizedDriveId,
      itemId: normalizedItemId,
      permissionId: normalizedPermissionId,
      outcome: "failed",
      failureReason: "inherited_permission_delete_blocked",
      details: { stage: "validation", inheritedFrom: permission?.inheritedFrom || null },
    });
    return NextResponse.json({ error: "inherited_permission_delete_blocked" }, { status: 403 });
  }

  const roles: string[] = Array.isArray(permission?.roles) ? permission.roles : [];
  const hasOwnerRole = roles.some((role) => typeof role === "string" && role.toLowerCase().includes("owner"));
  if (hasOwnerRole) {
    await safeWriteRevokeLog({
      actor,
      driveId: normalizedDriveId,
      itemId: normalizedItemId,
      permissionId: normalizedPermissionId,
      outcome: "failed",
      failureReason: "owner_permission_delete_blocked",
      details: { stage: "validation", roles },
    });
    return NextResponse.json({ error: "owner_permission_delete_blocked" }, { status: 403 });
  }

  try {
    await graphDelete(`/drives/${normalizedDriveId}/items/${normalizedItemId}/permissions/${encodedPermissionId}`);
  } catch (err: unknown) {
    const errorMessage = getErrorMessage(err, "graph_delete_permission_failed");
    await safeWriteRevokeLog({
      actor,
      driveId: normalizedDriveId,
      itemId: normalizedItemId,
      permissionId: normalizedPermissionId,
      outcome: "failed",
      failureReason: sanitizeReason(errorMessage),
      details: { stage: "graph_delete_permission" },
    });
    return NextResponse.json({ error: errorMessage }, { status: 502 });
  }

  let warning: string | null = null;

  try {
    await withTransaction(async (client) => {
      await client.query(
        `
      DELETE FROM msgraph_drive_item_permission_grants
      WHERE drive_id = $1 AND item_id = $2 AND permission_id = $3
      `,
        [normalizedDriveId, normalizedItemId, normalizedPermissionId]
      );
      await client.query(
        `
      DELETE FROM msgraph_drive_item_permissions
      WHERE drive_id = $1 AND item_id = $2 AND permission_id = $3
      `,
        [normalizedDriveId, normalizedItemId, normalizedPermissionId]
      );
      await client.query(
        `
      UPDATE msgraph_drive_items
      SET permissions_last_synced_at = now(),
          permissions_last_error_at = NULL,
          permissions_last_error = NULL,
          permissions_last_error_details = NULL
      WHERE drive_id = $1 AND id = $2
      `,
        [normalizedDriveId, normalizedItemId]
      );
    });
  } catch (err: unknown) {
    warning = `graph_delete_succeeded_local_sync_failed: ${getErrorMessage(err, "unknown_sync_error")}`;
  }

  try {
    await writeAuditEvent({
      action: "permission_deleted",
      entityType: "drive_item_permission",
      entityId: `${normalizedDriveId}:${normalizedItemId}:${normalizedPermissionId}`,
      actor: {
        oid: (session?.user as any)?.oid,
        upn: (session?.user as any)?.upn,
        name: session?.user?.name,
      },
      details: {
        driveId: normalizedDriveId,
        itemId: normalizedItemId,
        permissionId: normalizedPermissionId,
        roles,
        link: permission?.link || null,
      },
    });
  } catch (err: unknown) {
    const auditWarning = `audit_write_failed: ${getErrorMessage(err, "unknown_audit_error")}`;
    warning = warning ? `${warning}; ${auditWarning}` : auditWarning;
  }

  await safeWriteRevokeLog({
    actor,
    driveId: normalizedDriveId,
    itemId: normalizedItemId,
    permissionId: normalizedPermissionId,
    outcome: "success",
    warning: warning ? sanitizeReason(warning, 500) : null,
    details: {
      stage: "completed",
      roles,
      link: permission?.link || null,
    },
  });

  if (warning) {
    return NextResponse.json({ ok: true, warning });
  }

  return NextResponse.json({ ok: true });
};

export const GET = withApiRequestTiming("/api/graph/drive-item-permissions", getHandler);
export const DELETE = withApiRequestTiming("/api/graph/drive-item-permissions", deleteHandler);

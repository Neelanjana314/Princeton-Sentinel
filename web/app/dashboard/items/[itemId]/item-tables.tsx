"use client";

import Link from "next/link";
import * as React from "react";
import { useRouter } from "next/navigation";

import { getCsrfFetchHeaders } from "@/app/lib/csrf-client";
import { SortableTable } from "@/components/sortable-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatIsoDateTime } from "@/app/lib/format";

type LinkBreakdownRow = {
  link_scope: string | null;
  link_type: string | null;
  count: number;
};

type AccessLinkRow = {
  permissionId: string;
  source: "direct" | "inherited";
  inheritedFromItemId: string | null;
  link_scope: string;
  link_type: string | null;
  link_webUrl: string | null;
  link_expiration: string | null;
  preventsDownload: boolean | null;
  roles: string[];
};

type PrincipalRow = {
  type: "user" | "group" | "siteGroup" | "application" | "link" | "unknown";
  id: string | null;
  displayName: string | null;
  email: string | null;
  classification: "guest" | "external" | "internal" | "unknown";
  grants: number;
  viaLinks: number;
  viaDirect: number;
  directPermissionIds: string[];
};

type PermissionRow = {
  permissionId: string;
  source: "direct" | "inherited";
  inheritedFromItemId: string | null;
  link_scope: string | null;
  link_type: string | null;
  roles: string[];
  principalCount: number;
  isOwnerRole: boolean;
  isSyntheticId: boolean;
  revokeBlockedReason: "inherited" | "owner" | "missing_id" | null;
};

type DeletePermissionResult = {
  ok: boolean;
  error?: string;
  warning?: string;
};

type ActionStatus = {
  kind: "success" | "failed" | "partial" | "sync-delay";
  message: string;
};

function sanitizeResponseText(text: string): string {
  return text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

async function errorMessageFromResponse(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (text) {
      try {
        const data = JSON.parse(text);
        if (data?.error) return String(data.error);
        if (data?.warning) return String(data.warning);
      } catch {
        // ignore parse errors
      }
      const cleaned = sanitizeResponseText(text);
      if (cleaned) return cleaned;
    }
  } catch {
    // ignore read errors
  }
  return `Request failed with status ${res.status}`;
}

async function deletePermission(
  driveId: string,
  itemId: string,
  permissionId: string,
  csrfToken: string,
): Promise<DeletePermissionResult> {
  try {
    const res = await fetch("/api/graph/drive-item-permissions", {
      method: "DELETE",
      headers: getCsrfFetchHeaders({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken }),
      body: JSON.stringify({ driveId, itemId, permissionId }),
    });
    if (res.ok) {
      let warning: string | undefined;
      try {
        const body = await res.clone().json();
        if (body?.warning) warning = String(body.warning);
      } catch {
        // best-effort read
      }
      return { ok: true, warning };
    }
    return { ok: false, error: await errorMessageFromResponse(res) };
  } catch (err: any) {
    return { ok: false, error: err?.message || "Request failed" };
  }
}

async function fetchLivePermissionIds(driveId: string, itemId: string): Promise<Set<string> | null> {
  try {
    const params = new URLSearchParams({ driveId, itemId });
    const res = await fetch(`/api/graph/drive-item-permissions?${params.toString()}`, {
      method: "GET",
      cache: "no-store",
    });
    if (!res.ok) return null;
    const payload = await res.json();
    const values = Array.isArray(payload?.data?.value) ? payload.data.value : [];
    const ids = values
      .map((entry: any) => (entry?.id ? String(entry.id) : ""))
      .filter((id: string) => id.length > 0);
    return new Set(ids);
  } catch {
    return null;
  }
}

function statusClassName(kind: ActionStatus["kind"]): string {
  switch (kind) {
    case "success":
      return "text-emerald-700 dark:text-emerald-300";
    case "partial":
      return "text-amber-700 dark:text-amber-300";
    case "sync-delay":
      return "text-blue-700 dark:text-blue-300";
    default:
      return "text-red-700 dark:text-red-300";
  }
}

function revokeBlockedReasonMessage(reason: PermissionRow["revokeBlockedReason"]): string {
  switch (reason) {
    case "inherited":
      return "Inherited permission; revoke at source item.";
    case "owner":
      return "Owner permission cannot be revoked from this view.";
    case "missing_id":
      return "Permission ID unavailable for revoke.";
    default:
      return "";
  }
}

export function ItemLinkBreakdownTable({ breakdown }: { breakdown: LinkBreakdownRow[] }) {
  const columns = React.useMemo(
    () => [
      {
        id: "scope",
        header: "Scope",
        sortValue: (r: LinkBreakdownRow) => r.link_scope ?? "",
        cell: (r: LinkBreakdownRow) => <span className="text-muted-foreground">{r.link_scope ?? "—"}</span>,
      },
      {
        id: "type",
        header: "Type",
        sortValue: (r: LinkBreakdownRow) => r.link_type ?? "",
        cell: (r: LinkBreakdownRow) => <span className="text-muted-foreground">{r.link_type ?? "—"}</span>,
      },
      {
        id: "count",
        header: "Links",
        sortValue: (r: LinkBreakdownRow) => r.count,
        cell: (r: LinkBreakdownRow) => <span className="text-muted-foreground">{r.count.toLocaleString()}</span>,
      },
    ],
    []
  );

  return (
    <SortableTable
      items={breakdown}
      columns={columns}
      getRowKey={(r, idx) => `${r.link_scope ?? "null"}:${r.link_type ?? "null"}:${idx}`}
      emptyMessage="No sharing links found for this item."
    />
  );
}

export function ItemAccessLinksTable({ links }: { links: AccessLinkRow[] }) {
  const columns = React.useMemo(
    () => [
      {
        id: "scope",
        header: "Scope",
        sortValue: (r: AccessLinkRow) => r.link_scope,
        cell: (r: AccessLinkRow) => <span className="text-muted-foreground">{r.link_scope}</span>,
      },
      {
        id: "type",
        header: "Type",
        sortValue: (r: AccessLinkRow) => r.link_type ?? "",
        cell: (r: AccessLinkRow) => <span className="text-muted-foreground">{r.link_type ?? "—"}</span>,
      },
      {
        id: "roles",
        header: "Roles",
        sortValue: (r: AccessLinkRow) => r.roles.join(","),
        cell: (r: AccessLinkRow) => <span className="text-muted-foreground">{r.roles.length ? r.roles.join(", ") : "—"}</span>,
      },
      {
        id: "expires",
        header: "Expires",
        sortValue: (r: AccessLinkRow) => r.link_expiration ?? "",
        cell: (r: AccessLinkRow) => <span className="text-muted-foreground">{formatIsoDateTime(r.link_expiration)}</span>,
      },
      {
        id: "url",
        header: "Link",
        sortValue: (r: AccessLinkRow) => r.link_webUrl ?? "",
        cell: (r: AccessLinkRow) => (
          <div className="max-w-[520px]">
            <div className="font-medium">
              {r.link_webUrl ? (
                <a className="hover:underline" href={r.link_webUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </div>
            <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{r.link_webUrl ?? r.permissionId}</div>
          </div>
        ),
      },
    ],
    []
  );

  return <SortableTable items={links} columns={columns} getRowKey={(r) => r.permissionId} emptyMessage="No sharing link URLs found for this item." />;
}

function badgeForClassification(c: PrincipalRow["classification"]) {
  switch (c) {
    case "guest":
      return <Badge className="border-red-200 bg-red-50 text-red-700">Guest</Badge>;
    case "external":
      return <Badge className="border-primary/35 bg-primary/15 text-foreground">External</Badge>;
    case "internal":
      return <Badge className="border-border bg-muted text-muted-foreground">Internal</Badge>;
    default:
      return <Badge variant="outline">Unknown</Badge>;
  }
}

export function ItemPrincipalsTable({
  principals,
  isAdmin,
  driveId,
  itemId,
  csrfToken,
}: {
  principals: PrincipalRow[];
  isAdmin: boolean;
  driveId: string;
  itemId: string;
  csrfToken: string;
}) {
  const router = useRouter();
  const [actionStatus, setActionStatus] = React.useState<Record<string, ActionStatus>>({});
  const [actionBusy, setActionBusy] = React.useState<Record<string, boolean>>({});
  const hardReloadedRef = React.useRef(false);

  const rowKey = React.useCallback(
    (p: PrincipalRow) => `${p.type}:${p.id ?? p.email ?? p.displayName ?? "unknown"}`,
    []
  );

  const columns = React.useMemo(() => {
    const base = [
      {
        id: "principal",
        header: "Principal",
        sortValue: (p: PrincipalRow) => p.email ?? p.displayName ?? "",
        cell: (p: PrincipalRow) => (
          <div className="max-w-[520px]">
            <div className="font-medium">{p.email ?? p.displayName ?? p.id ?? "—"}</div>
            <div className="truncate text-xs text-muted-foreground">{p.displayName && p.email ? p.displayName : p.id}</div>
          </div>
        ),
      },
      {
        id: "type",
        header: "Type",
        sortValue: (p: PrincipalRow) => p.type,
        cell: (p: PrincipalRow) => <span className="text-muted-foreground">{p.type}</span>,
      },
      {
        id: "class",
        header: "Class",
        sortValue: (p: PrincipalRow) => p.classification,
        cell: (p: PrincipalRow) => badgeForClassification(p.classification),
      },
      {
        id: "grants",
        header: "Grants",
        sortValue: (p: PrincipalRow) => p.grants,
        cell: (p: PrincipalRow) => <span className="text-muted-foreground">{p.grants.toLocaleString()}</span>,
      },
      {
        id: "viaLinks",
        header: "Via links",
        sortValue: (p: PrincipalRow) => p.viaLinks,
        cell: (p: PrincipalRow) => <span className="text-muted-foreground">{p.viaLinks.toLocaleString()}</span>,
      },
    ];

    if (!isAdmin) return base;

    base.push({
      id: "actions",
      header: "Actions",
      sortValue: () => 0,
      cell: (p: PrincipalRow) => {
        const key = rowKey(p);
        const status = actionStatus[key];
        const busy = actionBusy[key];
        const canRevoke = p.directPermissionIds.length > 0;
        return (
          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!canRevoke || busy}
              onClick={async () => {
                if (!canRevoke || busy) return;
                const confirmed = window.confirm("Revoke explicit access for this principal?");
                if (!confirmed) return;
                setActionBusy((prev) => ({ ...prev, [key]: true }));
                setActionStatus((prev) => {
                  const next = { ...prev };
                  delete next[key];
                  return next;
                });

                const targetPermissionIds = [...p.directPermissionIds];
                const results = await Promise.all(
                  targetPermissionIds.map((permissionId) => deletePermission(driveId, itemId, permissionId, csrfToken))
                );
                const successCount = results.filter((r) => r.ok).length;
                const failures = results.filter((r) => !r.ok);
                const warnings = results.filter((r) => r.ok && r.warning).map((r) => String(r.warning));

                if (successCount > 0) {
                  router.refresh();
                  const livePermissionIds = await fetchLivePermissionIds(driveId, itemId);
                  if (livePermissionIds) {
                    const stillPresent = targetPermissionIds.filter((permissionId) => livePermissionIds.has(permissionId));
                    if (stillPresent.length > 0) {
                      setActionStatus((prev) => ({
                        ...prev,
                        [key]: {
                          kind: "sync-delay",
                          message: "Success on delete, but live data is delayed. Reloading…",
                        },
                      }));
                      if (!hardReloadedRef.current) {
                        hardReloadedRef.current = true;
                        window.setTimeout(() => window.location.reload(), 900);
                      }
                      setActionBusy((prev) => ({ ...prev, [key]: false }));
                      return;
                    }
                  }
                }

                if (failures.length === 0 && warnings.length === 0) {
                  setActionStatus((prev) => ({
                    ...prev,
                    [key]: { kind: "success", message: "Success: access revoked." },
                  }));
                } else if (failures.length === 0 && warnings.length > 0) {
                  setActionStatus((prev) => ({
                    ...prev,
                    [key]: {
                      kind: "partial",
                      message: `Partial: revoked with warning: ${warnings[0]}`,
                    },
                  }));
                } else if (successCount > 0) {
                  const firstError = failures[0].error || "Permission revoke failed";
                  setActionStatus((prev) => ({
                    ...prev,
                    [key]: {
                      kind: "partial",
                      message: `Partial: ${successCount} revoked, ${failures.length} failed: ${firstError}`,
                    },
                  }));
                } else {
                  const firstError = failures[0]?.error || "Permission revoke failed";
                  setActionStatus((prev) => ({
                    ...prev,
                    [key]: { kind: "failed", message: `Failed: ${firstError}` },
                  }));
                }
                setActionBusy((prev) => ({ ...prev, [key]: false }));
              }}
            >
              {busy ? "Revoking..." : "Revoke"}
            </Button>
            {status ? <div className={`text-xs ${statusClassName(status.kind)}`}>{status.message}</div> : null}
          </div>
        );
      },
    });

    return base;
  }, [actionBusy, actionStatus, csrfToken, driveId, itemId, isAdmin, rowKey, router]);

  return <SortableTable items={principals} columns={columns} getRowKey={rowKey} emptyMessage="No principals found." />;
}

export function ItemPermissionsTable({
  permissions,
  isAdmin,
  driveId,
  itemId,
  csrfToken,
}: {
  permissions: PermissionRow[];
  isAdmin: boolean;
  driveId: string;
  itemId: string;
  csrfToken: string;
}) {
  const router = useRouter();
  const [actionStatus, setActionStatus] = React.useState<Record<string, ActionStatus>>({});
  const [actionBusy, setActionBusy] = React.useState<Record<string, boolean>>({});
  const hardReloadedRef = React.useRef(false);

  const columns = React.useMemo(() => {
    const base = [
      {
        id: "perm",
        header: "Permission",
        sortValue: (p: PermissionRow) => p.permissionId,
        cell: (p: PermissionRow) => (
          <div className="max-w-[520px]">
            <div className="font-mono text-xs text-muted-foreground">{p.permissionId}</div>
            {p.inheritedFromItemId ? (
              <div className="text-xs text-muted-foreground">
                Inherited from{" "}
                <Link className="hover:underline" href={`/dashboard/items/${encodeURIComponent(p.inheritedFromItemId)}`}>
                  {p.inheritedFromItemId}
                </Link>
              </div>
            ) : null}
            {p.source === "inherited" && !p.inheritedFromItemId ? (
              <div className="text-xs text-muted-foreground">Inherited permission from parent item.</div>
            ) : null}
            {p.isSyntheticId ? <div className="text-xs text-muted-foreground">ID unavailable from Graph payload.</div> : null}
          </div>
        ),
      },
      {
        id: "source",
        header: "Source",
        sortValue: (p: PermissionRow) => p.source,
        cell: (p: PermissionRow) => <span className="text-muted-foreground">{p.source}</span>,
      },
      {
        id: "roles",
        header: "Roles",
        sortValue: (p: PermissionRow) => p.roles.join(","),
        cell: (p: PermissionRow) => <span className="text-muted-foreground">{p.roles.length ? p.roles.join(", ") : "—"}</span>,
      },
      {
        id: "link",
        header: "Link",
        sortValue: (p: PermissionRow) => `${p.link_scope ?? ""}:${p.link_type ?? ""}`,
        cell: (p: PermissionRow) => (
          <span className="text-muted-foreground">
            {p.link_scope ?? "—"} {p.link_type ? `(${p.link_type})` : ""}
          </span>
        ),
      },
      {
        id: "principals",
        header: "Principals",
        sortValue: (p: PermissionRow) => p.principalCount,
        cell: (p: PermissionRow) => <span className="text-muted-foreground">{p.principalCount.toLocaleString()}</span>,
      },
    ];

    if (!isAdmin) return base;

    base.push({
      id: "actions",
      header: "Actions",
      sortValue: () => 0,
      cell: (p: PermissionRow) => {
        const status = actionStatus[p.permissionId];
        const busy = actionBusy[p.permissionId];
        const blockedReason = p.revokeBlockedReason;
        const canRevoke = blockedReason == null;
        const blockedMessage = revokeBlockedReasonMessage(blockedReason);
        return (
          <div className="flex flex-col gap-1">
            <Button
              size="sm"
              variant="outline"
              disabled={!canRevoke || busy}
              onClick={async () => {
                if (!canRevoke || busy) return;
                const confirmed = window.confirm("Revoke this permission?");
                if (!confirmed) return;
                setActionBusy((prev) => ({ ...prev, [p.permissionId]: true }));
                setActionStatus((prev) => {
                  const next = { ...prev };
                  delete next[p.permissionId];
                  return next;
                });

                const result = await deletePermission(driveId, itemId, p.permissionId, csrfToken);
                if (!result.ok) {
                  setActionStatus((prev) => ({
                    ...prev,
                    [p.permissionId]: {
                      kind: "failed",
                      message: `Failed: ${result.error || "Permission revoke failed"}`,
                    },
                  }));
                } else {
                  router.refresh();
                  const livePermissionIds = await fetchLivePermissionIds(driveId, itemId);
                  if (livePermissionIds && livePermissionIds.has(p.permissionId)) {
                    setActionStatus((prev) => ({
                      ...prev,
                      [p.permissionId]: {
                        kind: "sync-delay",
                        message: "Success on delete, but live data is delayed. Reloading…",
                      },
                    }));
                    if (!hardReloadedRef.current) {
                      hardReloadedRef.current = true;
                      window.setTimeout(() => window.location.reload(), 900);
                    }
                    setActionBusy((prev) => ({ ...prev, [p.permissionId]: false }));
                    return;
                  }

                  if (result.warning) {
                    setActionStatus((prev) => ({
                      ...prev,
                      [p.permissionId]: {
                        kind: "partial",
                        message: `Partial: revoked with warning: ${result.warning}`,
                      },
                    }));
                  } else {
                    setActionStatus((prev) => ({
                      ...prev,
                      [p.permissionId]: { kind: "success", message: "Success: permission revoked." },
                    }));
                  }
                }
                setActionBusy((prev) => ({ ...prev, [p.permissionId]: false }));
              }}
            >
              {busy ? "Revoking..." : "Revoke"}
            </Button>
            {status ? <div className={`text-xs ${statusClassName(status.kind)}`}>{status.message}</div> : null}
            {!status && !canRevoke && blockedMessage ? <div className="text-xs text-muted-foreground">{blockedMessage}</div> : null}
          </div>
        );
      },
    });

    return base;
  }, [actionBusy, actionStatus, csrfToken, driveId, itemId, isAdmin, router]);

  return <SortableTable items={permissions} columns={columns} getRowKey={(p) => p.permissionId} emptyMessage="No permissions found." />;
}

import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isAdmin, requireUser } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { query } from "@/app/lib/db";
import { graphGet } from "@/app/lib/graph";
import { formatBytes, safeDecode } from "@/app/lib/format";
import { getInternalDomainPatterns } from "@/app/lib/internalDomains";
import LocalDateTime from "@/components/local-date-time";

import { ItemAccessLinksTable, ItemLinkBreakdownTable, ItemPermissionsTable, ItemPrincipalsTable } from "./item-tables";

type Principal = {
  key: string;
  id: string | null;
  displayName: string | null;
  email: string | null;
  type: "user" | "group" | "siteGroup" | "application" | "link" | "unknown";
  grants: number;
  viaLinks: number;
  classification: "guest" | "external" | "internal" | "unknown";
  permissionIds: string[];
  directPermissionIds: string[];
};

type RevokeBlockedReason = "inherited" | "owner" | "missing_id" | null;

function splitItemKey(raw: string) {
  const decoded = safeDecode(raw);
  const parts = decoded.split("::");
  if (parts.length < 2) return null;
  return { driveId: parts[0], itemId: parts.slice(1).join("::") };
}

function classifyEmail(email: string | null, patterns: string[]) {
  if (!email) return "unknown";
  const lower = email.toLowerCase();
  if (lower.includes("#ext#")) return "guest";
  if (!patterns.length) return "internal";
  const domain = lower.split("@")[1] || "";
  if (!domain) return "unknown";
  const isInternal = patterns.some((pattern) => {
    if (pattern.startsWith("%")) {
      return domain.endsWith(pattern.replace("%.", ""));
    }
    return domain === pattern;
  });
  return isInternal ? "internal" : "external";
}

function extractPrincipals(permission: any): Array<{ id?: string; displayName?: string; email?: string; type?: string }> {
  const identities: any[] = [];
  const pushIdentity = (obj: any) => {
    if (!obj) return;
    if (Array.isArray(obj)) {
      obj.forEach((entry) => identities.push(entry));
    } else {
      identities.push(obj);
    }
  };

  pushIdentity(permission.grantedToV2);
  pushIdentity(permission.grantedToIdentitiesV2);
  pushIdentity(permission.grantedTo);
  pushIdentity(permission.grantedToIdentities);

  return identities.map((identity) => {
    const user = identity?.user || identity?.siteUser;
    const group = identity?.group || identity?.siteGroup;
    const app = identity?.application;
    const principal = user || group || app || {};
    const type = user ? "user" : group ? "group" : app ? "application" : "unknown";
    return {
      id: principal.id,
      displayName: principal.displayName || principal.name,
      email: principal.email || principal.userPrincipalName,
      type,
    };
  });
}

export const dynamic = "force-dynamic";

async function ItemDetailPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { groups } = await requireUser();
  const admin = isAdmin(groups);
  const csrfToken = await getCsrfRenderToken();

  const { itemId: encodedItemId } = await params;
  const key = splitItemKey(encodedItemId);
  if (!key) notFound();

  const { driveId, itemId } = key;

  const itemRows = await query<any>(
    `
    SELECT i.*, d.name AS drive_name, d.drive_type, d.web_url AS drive_web_url, d.quota_used, d.quota_total,
           d.owner_display_name, d.owner_email
    FROM msgraph_drive_items i
    JOIN msgraph_drives d ON d.id = i.drive_id
    WHERE i.drive_id = $1
      AND i.id = $2
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
    `,
    [driveId, itemId]
  );

  if (!itemRows.length) notFound();
  const item = itemRows[0];

  let liveItem: any = null;
  let livePerms: any[] = [];
  let liveError: string | null = null;
  try {
    liveItem = await graphGet(
      `/drives/${driveId}/items/${itemId}?select=id,name,webUrl,createdDateTime,lastModifiedDateTime,createdBy,lastModifiedBy,file,folder,shared,parentReference`
    );
    const perms = await graphGet(`/drives/${driveId}/items/${itemId}/permissions`);
    livePerms = Array.isArray(perms?.value) ? perms.value : [];
  } catch (err: any) {
    liveError = err?.message || "Failed to load live Graph data";
  }

  const patterns = getInternalDomainPatterns();
  const linkBreakdownMap = new Map<string, { link_scope: string | null; link_type: string | null; count: number }>();
  const accessLinks: any[] = [];
  const permissions: any[] = [];
  type PrincipalAccum = Omit<Principal, "permissionIds" | "directPermissionIds"> & {
    permissionIds: Set<string>;
    directPermissionIds: Set<string>;
  };
  const principalMap = new Map<string, PrincipalAccum>();

  for (const [index, perm] of livePerms.entries()) {
    const graphPermissionId = typeof perm.id === "string" && perm.id.trim() ? perm.id : null;
    const permId = graphPermissionId ?? `perm-${index}`;
    const isSyntheticId = !graphPermissionId;
    const link = perm.link || null;
    const roles = Array.isArray(perm.roles) ? perm.roles : [];
    const inheritedKey = perm.inheritedFrom?.driveId && perm.inheritedFrom?.id ? `${perm.inheritedFrom.driveId}::${perm.inheritedFrom.id}` : null;
    const source: "direct" | "inherited" = perm.inheritedFrom ? "inherited" : "direct";
    const isOwnerRole = roles.some((role) => typeof role === "string" && role.toLowerCase().includes("owner"));
    const revokeBlockedReason: RevokeBlockedReason =
      source === "inherited" ? "inherited" : isOwnerRole ? "owner" : isSyntheticId ? "missing_id" : null;
    if (link) {
      const scope = link.scope ?? null;
      const type = link.type ?? null;
      const keyVal = `${scope ?? "null"}::${type ?? "null"}`;
      const existing = linkBreakdownMap.get(keyVal) || { link_scope: scope, link_type: type, count: 0 };
      existing.count += 1;
      linkBreakdownMap.set(keyVal, existing);

      accessLinks.push({
        permissionId: permId,
        source,
        inheritedFromItemId: inheritedKey,
        link_scope: scope ?? "unknown",
        link_type: type ?? null,
        link_webUrl: link.webUrl ?? null,
        link_expiration: link.expirationDateTime ?? null,
        preventsDownload: link.preventsDownload ?? null,
        roles,
      });
    }

    const principals = extractPrincipals(perm);
    permissions.push({
      permissionId: permId,
      source,
      inheritedFromItemId: inheritedKey,
      link_scope: link?.scope ?? null,
      link_type: link?.type ?? null,
      roles,
      principalCount: principals.length,
      isOwnerRole,
      isSyntheticId,
      revokeBlockedReason,
    });
    const viaLink = !!link;
    for (const principal of principals) {
      const keyVal = principal.email || principal.id || principal.displayName || "unknown";
      const existing =
        principalMap.get(keyVal) ||
        ({
          key: keyVal,
          id: principal.id ?? null,
          displayName: principal.displayName ?? null,
          email: principal.email ?? null,
          type: (principal.type as Principal["type"]) ?? "unknown",
          grants: 0,
          viaLinks: 0,
          classification: classifyEmail(principal.email || null, patterns),
          permissionIds: new Set<string>(),
          directPermissionIds: new Set<string>(),
        } satisfies PrincipalAccum);
      if (!existing.id && principal.id) existing.id = principal.id;
      if (!existing.email && principal.email) existing.email = principal.email;
      if (!existing.displayName && principal.displayName) existing.displayName = principal.displayName;
      if (existing.type === "unknown" && principal.type) existing.type = principal.type as Principal["type"];
      if (existing.classification === "unknown") {
        existing.classification = classifyEmail(existing.email ?? principal.email ?? null, patterns);
      }
      existing.grants += 1;
      if (viaLink) existing.viaLinks += 1;
      existing.permissionIds.add(permId);
      if (source === "direct") {
        existing.directPermissionIds.add(permId);
      }
      principalMap.set(keyVal, existing);
    }
  }

  const principalList = Array.from(principalMap.values())
    .map((p) => {
      const { permissionIds, directPermissionIds, ...rest } = p;
      return {
        ...rest,
        permissionIds: Array.from(permissionIds),
        directPermissionIds: Array.from(directPermissionIds),
        viaDirect: rest.grants - rest.viaLinks,
      };
    })
    .sort((a, b) => b.grants - a.grants);
  const guestCount = principalList.filter((p) => p.classification === "guest").length;
  const externalCount = principalList.filter((p) => p.classification === "external").length;

  const linkBreakdown = Array.from(linkBreakdownMap.values());
  const hasAnonymousLink = linkBreakdown.some((r) => r.link_scope === "anonymous");
  const hasOrgLink = linkBreakdown.some((r) => r.link_scope === "organization");
  const hasUsersLink = linkBreakdown.some((r) => r.link_scope === "users");

  const path = item.normalized_path ? `${item.normalized_path}/${item.name}` : item.path || item.name;
  const isShared = item.is_shared || linkBreakdown.length > 0;

  const createdAt = liveItem?.createdDateTime || item.created_dt;
  const modifiedAt = liveItem?.lastModifiedDateTime || item.modified_dt;

  const lastModifiedBy = item.last_modified_by_email || item.last_modified_by_display_name || item.last_modified_by_user_id || "—";
  const createdBy = item.created_by_email || item.created_by_display_name || item.created_by_user_id || "—";

  return (
    <main className="ps-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold">{item.name || item.id}</h1>
            <Badge variant="outline">{item.is_folder ? "Folder" : "File"}</Badge>
            {isShared ? <Badge className="border-primary/35 bg-primary/15 text-foreground">Shared</Badge> : null}
            {hasAnonymousLink ? <Badge className="border-red-200 bg-red-50 text-red-700">Anonymous link</Badge> : null}
            {hasOrgLink ? <Badge className="border-primary/35 bg-primary/15 text-foreground">Org-wide link</Badge> : null}
            {hasUsersLink ? <Badge className="border-border bg-muted text-muted-foreground">Specific users link</Badge> : null}
          </div>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{path}</p>
          <p className="mt-1 truncate text-xs text-muted-foreground">{item.id}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Last modified <LocalDateTime value={modifiedAt} /> • Created <LocalDateTime value={createdAt} />
          </p>
          <p className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">Live (Graph)</p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Link className="text-muted-foreground hover:underline" href="/dashboard/risk">
            Risk
          </Link>
          {item.web_url ? (
            <a className="text-muted-foreground hover:underline" href={item.web_url} target="_blank" rel="noreferrer">
              Open in M365
            </a>
          ) : null}
          {item.drive_web_url ? (
            <a className="text-muted-foreground hover:underline" href={item.drive_web_url} target="_blank" rel="noreferrer">
              Open drive
            </a>
          ) : null}
        </div>
      </div>

      {liveError ? (
        <Card>
          <CardHeader>
            <CardTitle>Live data unavailable</CardTitle>
            <CardDescription>{liveError}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Item</CardTitle>
            <CardDescription>Metadata</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Size</span>
              <span className="font-medium">{item.is_folder ? "—" : formatBytes(item.size)}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Last modified by</span>
              <span className="font-medium">{lastModifiedBy}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Created by</span>
              <span className="font-medium">{createdBy}</span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Drive</CardTitle>
            <CardDescription>Context</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Type</span>
              <span className="font-medium">{item.drive_type ?? "—"}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Owner</span>
              <span className="font-medium">{item.owner_email || item.owner_display_name || "—"}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Quota used</span>
              <span className="font-medium">
                {formatBytes(item.quota_used)} / {formatBytes(item.quota_total)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Sharing</CardTitle>
            <CardDescription>Exposure summary</CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Link shares</span>
              <span className="font-medium">{linkBreakdown.reduce((sum, r) => sum + Number(r.count ?? 0), 0).toLocaleString()}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Principals</span>
              <span className="font-medium">{principalList.length.toLocaleString()}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-muted-foreground">Guests / external</span>
              <span className="font-medium">
                {guestCount.toLocaleString()} / {externalCount.toLocaleString()}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Access links</CardTitle>
          <CardDescription>Share links (including organization-wide) for this item when available.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ItemAccessLinksTable links={accessLinks} />
        </CardContent>
      </Card>

      <div className="grid gap-3">
        <Card>
          <CardHeader>
            <CardTitle>Sharing links</CardTitle>
            <CardDescription>Current link scopes/types seen on this item</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ItemLinkBreakdownTable breakdown={linkBreakdown} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Principals</CardTitle>
            <CardDescription>People, groups, and apps with direct grants (excludes link principal)</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <ItemPrincipalsTable principals={principalList} isAdmin={admin} driveId={driveId} itemId={itemId} csrfToken={csrfToken} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>Direct vs inherited entries, roles, and principal counts</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <ItemPermissionsTable permissions={permissions} isAdmin={admin} driveId={driveId} itemId={itemId} csrfToken={csrfToken} />
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/dashboard/items/[itemId]", ItemDetailPage);

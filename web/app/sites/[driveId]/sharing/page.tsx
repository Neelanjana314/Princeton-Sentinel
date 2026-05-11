import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { safeDecode } from "@/app/lib/format";
import { getInternalDomainPatterns } from "@/app/lib/internalDomains";

import {
  SiteExternalPrincipalsTable,
  SiteMostSharedItemsTable,
  SiteSharingLinkBreakdownTable,
} from "./site-sharing-tables";
import { SiteAvailabilityNotice } from "../site-availability-notice";

export const dynamic = "force-dynamic";

async function DriveSharingPage({ params }: { params: Promise<{ driveId: string }> }) {
  await requireUser();

  const { driveId: encodedDriveId } = await params;
  const driveId = safeDecode(encodedDriveId);

  const driveRows = await query<any>(
    `
    SELECT
      d.id,
      d.site_id,
      d.name,
      d.is_available,
      d.last_available_at,
      d.availability_reason,
      d.owner_display_name,
      d.owner_email,
      u.display_name AS owner_user_name,
      s.name AS site_name
    FROM msgraph_drives d
    LEFT JOIN msgraph_users u ON u.id = d.owner_id AND u.deleted_at IS NULL
    LEFT JOIN msgraph_sites s ON s.id = d.site_id AND s.deleted_at IS NULL
    WHERE d.id = $1
      AND d.deleted_at IS NULL
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
    LIMIT 1
    `,
    [driveId]
  );
  const drive = driveRows[0];
  if (!drive) notFound();

  const title = drive.site_id
    ? drive.site_name || drive.name || drive.id
    : drive.owner_user_name || drive.owner_display_name || drive.owner_email || drive.name || drive.id;

  const linkBreakdown = await query<any>(
    `
    SELECT p.link_scope, p.link_type, COUNT(*)::int AS count
    FROM msgraph_drive_item_permissions p
    WHERE p.deleted_at IS NULL
      AND p.drive_id = $1
    GROUP BY p.link_scope, p.link_type
    ORDER BY count DESC
    `,
    [driveId]
  );

  const patterns = getInternalDomainPatterns();
  const externalPrincipals = await query<any>(
    `
    WITH grants AS (
      SELECT
        COALESCE(g.principal_email, g.principal_user_principal_name) AS email,
        MAX(p.synced_at) AS last_grant,
        COUNT(*)::int AS grants
      FROM msgraph_drive_item_permission_grants g
      JOIN msgraph_drive_item_permissions p
        ON p.drive_id = g.drive_id AND p.item_id = g.item_id AND p.permission_id = g.permission_id
      WHERE g.deleted_at IS NULL AND p.deleted_at IS NULL
        AND p.drive_id = $1
        AND COALESCE(g.principal_email, g.principal_user_principal_name) IS NOT NULL
      GROUP BY COALESCE(g.principal_email, g.principal_user_principal_name)
    ), classified AS (
      SELECT
        email,
        grants,
        last_grant,
        CASE
          WHEN email ILIKE '%#EXT#%' THEN 'guest'
          WHEN COALESCE(array_length($2::text[], 1), 0) > 0
            AND NOT (split_part(lower(email), '@', 2) LIKE ANY($2::text[])) THEN 'external'
          ELSE 'internal'
        END AS kind
      FROM grants
    )
    SELECT email, kind, grants, last_grant
    FROM classified
    WHERE kind IN ('guest', 'external')
    ORDER BY grants DESC
    LIMIT 25
    `,
    [driveId, patterns]
  );

  const mostShared = await query<any>(
    `
    SELECT
      i.drive_id,
      i.id,
      i.name,
      i.web_url,
      COUNT(p.permission_id)::int AS permissions,
      COUNT(*) FILTER (WHERE p.link_scope IS NOT NULL)::int AS sharing_links,
      MAX(p.synced_at) AS last_shared
    FROM msgraph_drive_items i
    LEFT JOIN msgraph_drive_item_permissions p
      ON p.drive_id = i.drive_id AND p.item_id = i.id AND p.deleted_at IS NULL
    WHERE i.deleted_at IS NULL
      AND i.drive_id = $1
    GROUP BY i.drive_id, i.id, i.name, i.web_url
    ORDER BY sharing_links DESC NULLS LAST, permissions DESC NULLS LAST
    LIMIT 25
    `,
    [driveId]
  );

  return (
    <main className="ps-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{title}: Sharing</h1>
          <p className="text-sm text-muted-foreground">Breakdown of sharing links and external principals.</p>
          <p className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">Cached (DB)</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(driveId)}`}>
            Overview
          </Link>
          <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(driveId)}/files`}>
            Files
          </Link>
        </div>
      </div>

      <SiteAvailabilityNotice
        isAvailable={drive.is_available}
        lastAvailableAt={drive.last_available_at}
        availabilityReason={drive.availability_reason}
      />

      <Card>
        <CardHeader>
          <CardTitle>Link breakdown</CardTitle>
          <CardDescription>By scope and type</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SiteSharingLinkBreakdownTable driveId={driveId} breakdown={linkBreakdown} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>External principals</CardTitle>
          <CardDescription>Guests (`#EXT#`) and non-internal domains</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SiteExternalPrincipalsTable
            principals={externalPrincipals.map((row: any) => ({
              email: row.email,
              type: row.kind,
              grants: row.grants ?? 0,
              lastGrantedDateTime: row.last_grant,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Most shared items</CardTitle>
          <CardDescription>Ranked by sharing links and total permissions</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SiteMostSharedItemsTable
            items={mostShared.map((row: any) => ({
              itemId: `${row.drive_id}::${row.id}`,
              name: row.name || row.id,
              webUrl: row.web_url,
              sharingLinks: row.sharing_links ?? 0,
              permissions: row.permissions ?? 0,
              lastSharedDateTime: row.last_shared,
            }))}
          />
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/sites/[driveId]/sharing", DriveSharingPage);

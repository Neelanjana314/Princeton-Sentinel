import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { safeDecode } from "@/app/lib/format";

import { SiteLargestFilesTable, SiteMostPermissionedItemsTable, SiteRecentlyModifiedTable } from "./site-files-tables";
import { SiteAvailabilityNotice } from "../site-availability-notice";

export const dynamic = "force-dynamic";

function Heatmap({ cells }: { cells: Array<{ dayOfWeek: number; hour: number; count: number }> }) {
  const byKey = new Map(cells.map((c) => [`${c.dayOfWeek}:${c.hour}`, c.count]));
  const max = Math.max(...cells.map((c) => c.count), 0);
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[900px]">
        <div className="grid grid-cols-[64px_repeat(24,32px)] gap-1 text-xs">
          <div />
          {Array.from({ length: 24 }).map((_, h) => (
            <div key={h} className="text-center text-muted-foreground">
              {h}
            </div>
          ))}
          {weekdays.map((label, dayIdx) => (
            <div key={label} className="contents">
              <div className="flex items-center justify-end pr-2 text-muted-foreground">{label}</div>
              {Array.from({ length: 24 }).map((_, hour) => {
                const count = byKey.get(`${dayIdx}:${hour}`) ?? 0;
                const alpha = max <= 0 ? 0 : 0.08 + (count / max) * 0.75;
                return (
                  <div
                    key={`${label}:${hour}`}
                    title={`${label} ${hour}:00 — ${count.toLocaleString()} writes`}
                    className="h-6 rounded border"
                    style={{
                      backgroundColor: count > 0 ? `hsl(var(--primary) / ${alpha})` : "transparent",
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

async function DriveFilesPage({ params }: { params: Promise<{ driveId: string }> }) {
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

  const heatmapRows = await query<any>(
    `
    SELECT EXTRACT(DOW FROM i.modified_dt)::int AS dow,
           EXTRACT(HOUR FROM i.modified_dt)::int AS hour,
           COUNT(*)::int AS count
    FROM msgraph_drive_items i
    WHERE i.deleted_at IS NULL
      AND i.drive_id = $1
      AND i.modified_dt IS NOT NULL
    GROUP BY EXTRACT(DOW FROM i.modified_dt), EXTRACT(HOUR FROM i.modified_dt)
    ORDER BY dow, hour
    `,
    [driveId]
  );

  const recentlyModified = await query<any>(
    `
    SELECT i.drive_id, i.id, i.name, i.web_url, i.normalized_path, i.path, i.modified_dt
    FROM msgraph_drive_items i
    WHERE i.deleted_at IS NULL
      AND i.drive_id = $1
    ORDER BY i.modified_dt DESC NULLS LAST
    LIMIT 25
    `,
    [driveId]
  );

  const largestFiles = await query<any>(
    `
    SELECT i.drive_id, i.id, i.name, i.web_url, i.normalized_path, i.path, i.size
    FROM msgraph_drive_items i
    WHERE i.deleted_at IS NULL
      AND i.drive_id = $1
      AND i.is_folder = false
    ORDER BY i.size DESC NULLS LAST
    LIMIT 25
    `,
    [driveId]
  );

  const mostShared = await query<any>(
    `
    SELECT
      i.drive_id,
      i.id,
      i.name,
      i.web_url,
      COUNT(p.permission_id)::int AS permissions,
      COUNT(*) FILTER (WHERE p.link_scope IS NOT NULL)::int AS sharing_links
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

  const heatmap = heatmapRows.map((row: any) => ({
    dayOfWeek: row.dow,
    hour: row.hour,
    count: row.count,
  }));

  return (
    <main className="ps-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{title}: Files</h1>
          <p className="text-sm text-muted-foreground">File-level signals based on drive item metadata.</p>
          <p className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">Cached (DB)</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(driveId)}`}>
            Overview
          </Link>
          <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(driveId)}/sharing`}>
            Sharing
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
          <CardTitle>Write heatmap</CardTitle>
          <CardDescription>Day-of-week × hour-of-day based on `lastModifiedDateTime`.</CardDescription>
        </CardHeader>
        <CardContent>
          <Heatmap cells={heatmap} />
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recently modified</CardTitle>
            <CardDescription>Latest writes</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <SiteRecentlyModifiedTable
              items={recentlyModified.map((row: any) => ({
                itemId: `${row.drive_id}::${row.id}`,
                name: row.name || row.id,
                webUrl: row.web_url,
                normalizedPath: row.normalized_path || row.path,
                lastModifiedDateTime: row.modified_dt,
              }))}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Largest files</CardTitle>
            <CardDescription>Top 25 by size</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <SiteLargestFilesTable
              items={largestFiles.map((row: any) => ({
                itemId: `${row.drive_id}::${row.id}`,
                name: row.name || row.id,
                webUrl: row.web_url,
                normalizedPath: row.normalized_path || row.path,
                size: row.size,
              }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Most shared/permissioned items</CardTitle>
          <CardDescription>Ranked by sharing links and total permissions</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <SiteMostPermissionedItemsTable
            items={mostShared.map((row: any) => ({
              itemId: `${row.drive_id}::${row.id}`,
              name: row.name || row.id,
              webUrl: row.web_url,
              sharingLinks: row.sharing_links ?? 0,
              permissions: row.permissions ?? 0,
            }))}
          />
        </CardContent>
      </Card>
    </main>
  );
}

export default withPageRequestTiming("/sites/[driveId]/files", DriveFilesPage);

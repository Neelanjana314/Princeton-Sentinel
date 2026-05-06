import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { getPagination, getParam, SearchParams } from "@/app/lib/params";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/pagination";
import { ResetFiltersButton } from "@/components/filter-bar";
import DataRefreshTimestamp, { getLatestDataRefreshFinishedAt } from "@/components/data-refresh-timestamp";

import { SharingLinkItemsTable } from "./link-items-table";

export const dynamic = "force-dynamic";

function parseNullable(value: string | null) {
  if (value == null) return null;
  const decoded = value.trim();
  if (!decoded) return null;
  if (decoded === "null" || decoded === "unknown") return null;
  return decoded;
}

async function SharingLinksPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireUser();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const scopeRaw = getParam(resolvedSearchParams, "scope");
  const typeRaw = getParam(resolvedSearchParams, "type");
  if (scopeRaw == null || typeRaw == null) notFound();

  const driveId = getParam(resolvedSearchParams, "driveId");
  const scope = parseNullable(scopeRaw);
  const type = parseNullable(typeRaw);
  const search = getParam(resolvedSearchParams, "q") || "";
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });
  const resetParams = new URLSearchParams({ scope: scopeRaw, type: typeRaw });
  if (driveId) resetParams.set("driveId", driveId);
  const resetHref = `/dashboard/sharing/links?${resetParams.toString()}`;

  const params: any[] = [];
  let idx = 1;
  const driveFilter = driveId ? `AND p.drive_id = $${idx++}` : "";
  if (driveId) params.push(driveId);
  const scopeFilter = scope === null ? "p.link_scope IS NULL" : `p.link_scope = $${idx++}`;
  if (scope !== null) params.push(scope);
  const typeFilter = type === null ? "p.link_type IS NULL" : `p.link_type = $${idx++}`;
  if (type !== null) params.push(type);

  let searchClause = "";
  if (search) {
    searchClause = `AND (LOWER(i.name) LIKE $${idx} OR LOWER(i.path) LIKE $${idx} OR LOWER(i.id) LIKE $${idx})`;
    params.push(`%${search.toLowerCase()}%`);
    idx += 1;
  }

  const countRows = await query<any>(
    `
    SELECT COUNT(DISTINCT (i.drive_id, i.id))::int AS total
    FROM msgraph_drive_item_permissions p
    JOIN msgraph_drive_items i ON i.drive_id = p.drive_id AND i.id = p.item_id
    JOIN msgraph_drives d ON d.id = i.drive_id
    WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL
      AND d.deleted_at IS NULL
      AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
      ${driveFilter}
      AND ${scopeFilter}
      AND ${typeFilter}
      ${searchClause}
    `,
    params
  );

  const total = countRows[0]?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;

  const listParams = [...params, pageSize, offset];
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const [rows, dataRefreshFinishedAt] = await Promise.all([
    query<any>(
      `
      SELECT
        i.drive_id,
        i.id,
        i.name,
        i.web_url,
        i.normalized_path,
        i.path,
        i.is_folder,
        i.size,
        MAX(i.modified_dt) AS last_modified_dt,
        COUNT(p.permission_id)::int AS matching_permissions
      FROM msgraph_drive_item_permissions p
      JOIN msgraph_drive_items i ON i.drive_id = p.drive_id AND i.id = p.item_id
      JOIN msgraph_drives d ON d.id = i.drive_id
      WHERE p.deleted_at IS NULL AND i.deleted_at IS NULL
        AND d.deleted_at IS NULL
        AND LOWER(COALESCE(d.web_url, '')) NOT LIKE '%cachelibrary%'
        ${driveFilter}
        AND ${scopeFilter}
        AND ${typeFilter}
        ${searchClause}
      GROUP BY i.drive_id, i.id, i.name, i.web_url, i.normalized_path, i.path, i.is_folder, i.size
      ORDER BY matching_permissions DESC NULLS LAST
      LIMIT ${limitParam} OFFSET ${offsetParam}
      `,
      listParams
    ),
    getLatestDataRefreshFinishedAt("graph_ingest"),
  ]);

  const items = rows.map((row: any) => ({
    itemId: `${row.drive_id}::${row.id}`,
    name: row.name || row.id,
    webUrl: row.web_url,
    normalizedPath: row.normalized_path || row.path,
    isFolder: row.is_folder ?? false,
    size: row.size,
    lastModifiedDateTime: row.last_modified_dt,
    matchingPermissions: row.matching_permissions ?? 0,
  }));

  const title = `${scope ?? "—"} / ${type ?? "—"}`;
  const backHref = driveId ? `/sites/${encodeURIComponent(driveId)}/sharing` : "/dashboard/sharing";
  const backLabel = driveId ? "Site sharing" : "Sharing";

  return (
    <main className="ps-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">Sharing links: {title}</h1>
          <p className="text-sm text-muted-foreground">
            {driveId
              ? "Items in this site drive that contribute to this link scope/type bucket."
              : "Items that contribute to this link scope/type bucket."}
          </p>
          <p className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">Cached (DB)</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3 text-sm">
          <DataRefreshTimestamp sourceLabel="Graph sync" finishedAt={dataRefreshFinishedAt} />
          <Link className="text-muted-foreground hover:underline" href={backHref}>
            {backLabel}
          </Link>
          {driveId ? (
            <Link className="text-muted-foreground hover:underline" href="/dashboard/sharing">
              All sites sharing
            </Link>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
          <CardDescription>
            {total.toLocaleString()} items • showing {items.length.toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto space-y-3">
          <form className="flex flex-wrap items-center gap-2" action="/dashboard/sharing/links" method="get">
            {driveId ? <input type="hidden" name="driveId" value={driveId} /> : null}
            <input type="hidden" name="scope" value={scopeRaw} />
            <input type="hidden" name="type" value={typeRaw} />
            <Input name="q" placeholder="Search items…" defaultValue={search} className="w-64" />
            <Input
              name="pageSize"
              type="number"
              min={10}
              max={200}
              defaultValue={String(pageSize)}
              className="w-24"
              title="Page size"
            />
            <Button type="submit" variant="outline">
              Apply
            </Button>
            <ResetFiltersButton href={resetHref} />
          </form>
          <SharingLinkItemsTable items={items} />
        </CardContent>
      </Card>

      <Pagination
        pathname="/dashboard/sharing/links"
        page={clampedPage}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ driveId: driveId || undefined, scope: scopeRaw, type: typeRaw, q: search || undefined, pageSize }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/sharing/links", SharingLinksPage);

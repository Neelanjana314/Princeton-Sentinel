import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/pagination";
import { ResetFiltersButton } from "@/components/filter-bar";
import { requireUser } from "@/app/lib/auth";
import { query } from "@/app/lib/db";
import { safeDecode } from "@/app/lib/format";
import { getPagination, getParam, SearchParams } from "@/app/lib/params";

import { GroupMembersTable } from "./group-members-table";

export const dynamic = "force-dynamic";

async function GroupDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ groupId: string }>;
  searchParams?: Promise<SearchParams>;
}) {
  await requireUser();

  const { groupId: encodedGroupId } = await params;
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const groupId = safeDecode(encodedGroupId);
  const search = getParam(resolvedSearchParams, "q") || "";
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });

  const groupRows = await query<any>(
    `SELECT id, display_name, mail, visibility FROM msgraph_groups WHERE id = $1 AND deleted_at IS NULL`,
    [groupId]
  );
  const group = groupRows[0];
  if (!group) notFound();

  const memberCounts = await query<any>(
    `SELECT member_count::int AS members FROM mv_msgraph_group_member_counts WHERE group_id = $1`,
    [groupId]
  );

  const drives = await query<any>(
    `
    SELECT id, name, drive_type, web_url, site_id
    FROM msgraph_drives
    WHERE owner_id = $1
      AND deleted_at IS NULL
      AND LOWER(COALESCE(web_url, '')) NOT LIKE '%cachelibrary%'
    ORDER BY name
    `,
    [groupId]
  );

  const memberClause = search
    ? "AND (LOWER(u.display_name) LIKE $2 OR LOWER(u.mail) LIKE $2 OR LOWER(u.user_principal_name) LIKE $2 OR LOWER(m.member_id) LIKE $2)"
    : "";

  const countRows = await query<any>(
    `
    SELECT COUNT(*)::int AS total
    FROM msgraph_group_memberships m
    LEFT JOIN msgraph_users u ON u.id = m.member_id
    WHERE m.group_id = $1 AND m.deleted_at IS NULL
    ${memberClause}
    `,
    search ? [groupId, `%${search.toLowerCase()}%`] : [groupId]
  );

  const total = countRows[0]?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;

  const memberRows = await query<any>(
    `
    SELECT m.member_id, m.member_type, u.display_name, u.mail, u.user_principal_name
    FROM msgraph_group_memberships m
    LEFT JOIN msgraph_users u ON u.id = m.member_id
    WHERE m.group_id = $1 AND m.deleted_at IS NULL
    ${memberClause}
    ORDER BY u.display_name NULLS LAST
    LIMIT $${search ? 3 : 2} OFFSET $${search ? 4 : 3}
    `,
    search ? [groupId, `%${search.toLowerCase()}%`, pageSize, offset] : [groupId, pageSize, offset]
  );

  const totalSites = new Set(drives.map((d: any) => d.site_id).filter(Boolean)).size;
  const totalDrives = drives.length;
  const memberCount = memberCounts[0]?.members ?? 0;

  return (
    <main className="ps-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{group.display_name ?? group.mail ?? groupId}</h1>
          <p className="mt-1 truncate text-xs text-muted-foreground">{groupId}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {group.visibility ?? "—"} • {memberCount.toLocaleString()} members
          </p>
          <p className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">Cached (DB)</p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link className="text-muted-foreground hover:underline" href="/dashboard/groups">
            Groups
          </Link>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{memberCount.toLocaleString()}</CardTitle>
            <CardDescription>Members</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{totalSites.toLocaleString()}</CardTitle>
            <CardDescription>SharePoint sites (via drives)</CardDescription>
          </CardHeader>
        </Card>
        <Card className="text-center">
          <CardHeader>
            <CardTitle className="text-3xl font-bold">{totalDrives.toLocaleString()}</CardTitle>
            <CardDescription>Drives</CardDescription>
          </CardHeader>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>SharePoint</CardTitle>
          <CardDescription>Best-effort association via `drives.owner_id` and `drives.site_id`.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {totalDrives ? (
            drives.map((d: any) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <div className="font-medium">{d.name ?? d.id}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {d.drive_type ?? "—"} • {d.site_id ?? "No SharePoint site id found"}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {d.id ? (
                    <Link className="text-muted-foreground hover:underline" href={`/sites/${encodeURIComponent(d.id)}`}>
                      Open site
                    </Link>
                  ) : null}
                  {d.web_url ? (
                    <a className="text-muted-foreground hover:underline" href={d.web_url} target="_blank" rel="noreferrer">
                      Open drive
                    </a>
                  ) : null}
                </div>
              </div>
            ))
          ) : (
            <div className="text-muted-foreground">No group-owned drives found in the ingest.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>
            {total.toLocaleString()} members • showing {memberRows.length.toLocaleString()}
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto space-y-3">
          <form className="flex flex-wrap items-center gap-2" action={`/dashboard/groups/${encodeURIComponent(groupId)}`} method="get">
            <Input name="q" placeholder="Search members…" defaultValue={search} className="w-64" />
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
            <ResetFiltersButton href={`/dashboard/groups/${encodeURIComponent(groupId)}`} />
          </form>
          <GroupMembersTable
            items={memberRows.map((row: any) => ({
              userId: row.member_id,
              displayName: row.display_name,
              email: row.mail,
              userPrincipalName: row.user_principal_name,
            }))}
          />
        </CardContent>
      </Card>

      <Pagination
        pathname={`/dashboard/groups/${encodeURIComponent(groupId)}`}
        page={clampedPage}
        pageSize={pageSize}
        totalItems={total}
        extraParams={{ q: search || undefined, pageSize }}
      />
    </main>
  );
}

export default withPageRequestTiming("/dashboard/groups/[groupId]", GroupDetailPage);

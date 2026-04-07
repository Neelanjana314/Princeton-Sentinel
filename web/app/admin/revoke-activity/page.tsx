import { withPageRequestTiming } from "@/app/lib/request-timing";
import Link from "next/link";

import {
  getRevokeLogCount,
  getRevokeLogsPage,
  itemFallback,
  itemPath,
  requestedBy,
} from "@/app/admin/revoke-activity/revoke-activity-queries";
import { requireAdmin } from "@/app/lib/auth";
import { getPagination, SearchParams } from "@/app/lib/params";
import { Pagination } from "@/components/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import LocalDateTime from "@/components/local-date-time";

async function AdminRevokeActivityPage({ searchParams }: { searchParams?: Promise<SearchParams> }) {
  await requireAdmin();

  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const { page, pageSize } = getPagination(resolvedSearchParams, { page: 1, pageSize: 50 });

  const total = await getRevokeLogCount();
  const totalPages = Math.max(Math.ceil(total / pageSize), 1);
  const clampedPage = Math.min(page, totalPages);
  const offset = (clampedPage - 1) * pageSize;
  const rows = await getRevokeLogsPage(pageSize, offset);

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Revoke Activity Logs</CardTitle>
            <CardDescription>
              {total.toLocaleString()} events • showing {rows.length.toLocaleString()}
            </CardDescription>
          </div>
          <Button asChild variant="outline">
            <a href="/api/admin/revoke-logs/export">Download Logs</a>
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <form action="/admin/revoke-activity" method="get" className="mb-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="page" value="1" />
            <label className="text-sm text-slate" htmlFor="pageSize">
              Rows per page
            </label>
            <Input id="pageSize" name="pageSize" type="number" min={10} max={200} defaultValue={String(pageSize)} className="w-24" />
            <Button type="submit" variant="outline">
              Apply
            </Button>
          </form>

          <table className="w-full table-fixed text-sm">
            <thead className="text-left text-slate/70">
              <tr>
                <th className="w-[168px] py-2 pr-3">Triggered At</th>
                <th className="w-[176px] py-2 pr-3">Requested By</th>
                <th className="w-[290px] py-2 pr-3">File</th>
                <th className="w-[152px] py-2 pr-3">Permission ID</th>
                <th className="w-[112px] py-2 pr-3">Outcome</th>
                <th className="py-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const detailHref =
                  row.drive_id && row.item_id ? `/dashboard/items/${encodeURIComponent(`${row.drive_id}::${row.item_id}`)}` : null;
                const displayPath = itemPath(row);
                const displayItemName = row.item_name || itemFallback(row);
                const reason = row.failure_reason || row.warning || "--";
                return (
                  <tr key={row.log_id} className="border-t align-top">
                    <td className="py-3 pr-3 text-slate">
                      <LocalDateTime value={row.occurred_at} />
                    </td>
                    <td className="truncate py-3 pr-3 text-ink" title={requestedBy(row)}>
                      {requestedBy(row)}
                    </td>
                    <td className="py-3 pr-3">
                      <div className="max-w-[290px]">
                        <div className="truncate font-medium text-ink" title={displayItemName}>
                          {detailHref ? (
                            <Link className="hover:underline" href={detailHref}>
                              {displayItemName}
                            </Link>
                          ) : (
                            displayItemName
                          )}
                        </div>
                        {displayPath ? <div className="truncate text-[11px] leading-4 text-slate">{displayPath}</div> : null}
                        {row.item_web_url ? (
                          <a
                            className="truncate text-[11px] leading-4 text-slate hover:underline"
                            href={row.item_web_url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open in M365
                          </a>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-3 pr-3">
                      <span className="block max-w-[148px] truncate font-mono text-[11px] text-slate" title={row.permission_id || "--"}>
                        {row.permission_id || "--"}
                      </span>
                    </td>
                    <td className="py-3 pr-3">
                      <span className={row.outcome === "success" ? "badge badge-ok" : "badge badge-error"}>
                        {row.outcome === "success" ? "Success" : "Failed"}
                      </span>
                    </td>
                    <td className="py-3 text-slate">
                      <div className="truncate" title={reason}>
                        {reason}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!rows.length ? (
                <tr>
                  <td className="py-8 text-center text-muted-foreground" colSpan={6}>
                    No revoke logs found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Pagination pathname="/admin/revoke-activity" page={clampedPage} pageSize={pageSize} totalItems={total} extraParams={{ pageSize }} />
    </div>
  );
}

export default withPageRequestTiming("/admin/revoke-activity", AdminRevokeActivityPage);

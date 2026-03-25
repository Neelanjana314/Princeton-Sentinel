"use client";

import Link from "next/link";
import * as React from "react";

import { SortableTable } from "@/components/sortable-table";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatIsoDateTime } from "@/app/lib/format";
import { describeAvailabilityReason } from "@/app/lib/site-availability";

type ActivityRow = {
  site_key: string;
  route_drive_id: string;
  title: string;
  template: string | null;
  is_personal: boolean | null;
  is_available: boolean | null;
  last_available_at: string | null;
  availability_reason: string | null;
  modified_items: number;
  shares: number;
  active_users: number;
  storage_used_bytes: number | null;
  storage_total_bytes: number | null;
  last_activity_dt: string | null;
};

function parseIsoToTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function windowLabel(windowDays: number | null): string {
  return windowDays == null ? "All-time" : `${windowDays}d`;
}

export function ActivityTable({ items, windowDays }: { items: ActivityRow[]; windowDays: number | null }) {
  const columns = React.useMemo(
    () => [
      {
        id: "site",
        header: "Site",
        sortValue: (s: ActivityRow) => s.title,
        cell: (s: ActivityRow) => (
          <div className="flex flex-col gap-1">
            <Link className="font-medium hover:underline" href={`/sites/${encodeURIComponent(s.route_drive_id)}`}>
              {s.title}
            </Link>
            <div className="flex flex-wrap items-center gap-1">
              {s.template ? <Badge variant="outline">{s.template}</Badge> : null}
              {s.is_personal === true ? <Badge>Personal</Badge> : null}
            </div>
          </div>
        ),
        cellClassName: "max-w-[420px]",
      },
      {
        id: "availability",
        header: "Availability",
        sortValue: (s: ActivityRow) => (s.is_available === false ? "unavailable" : "available"),
        cell: (s: ActivityRow) =>
          s.is_available === false ? (
            <div className="flex flex-col gap-1">
              <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-900">Unavailable</Badge>
              <span className="text-xs text-amber-700">{describeAvailabilityReason(s.availability_reason)}</span>
            </div>
          ) : (
            <Badge variant="outline">Available</Badge>
          ),
      },
      {
        id: "lastAvailable",
        header: "Last available",
        sortValue: (s: ActivityRow) => parseIsoToTs(s.last_available_at),
        cell: (s: ActivityRow) => <span className="text-muted-foreground">{formatIsoDateTime(s.last_available_at)}</span>,
      },
      {
        id: "modified",
        header: `Items last modified (${windowLabel(windowDays)})`,
        sortValue: (s: ActivityRow) => s.modified_items,
        cell: (s: ActivityRow) => <span className="text-muted-foreground">{s.modified_items.toLocaleString()}</span>,
      },
      {
        id: "shares",
        header: `Link permissions seen (${windowLabel(windowDays)})`,
        sortValue: (s: ActivityRow) => s.shares,
        cell: (s: ActivityRow) => <span className="text-muted-foreground">{s.shares.toLocaleString()}</span>,
      },
      {
        id: "activeUsers",
        header: `Users with last-modified items (${windowLabel(windowDays)})`,
        sortValue: (s: ActivityRow) => s.active_users,
        cell: (s: ActivityRow) => <span className="text-muted-foreground">{s.active_users.toLocaleString()}</span>,
      },
      {
        id: "storage",
        header: "Storage",
        sortValue: (s: ActivityRow) => s.storage_used_bytes,
        cell: (s: ActivityRow) => (
          <span className="text-muted-foreground">
            {formatBytes(s.storage_used_bytes)} / {formatBytes(s.storage_total_bytes)}
          </span>
        ),
      },
      {
        id: "lastActivity",
        header: "Last activity",
        sortValue: (s: ActivityRow) => parseIsoToTs(s.last_activity_dt),
        cell: (s: ActivityRow) => <span className="text-muted-foreground">{formatIsoDateTime(s.last_activity_dt)}</span>,
      },
    ],
    [windowDays]
  );

  return (
    <SortableTable
      mode="server"
      items={items}
      columns={columns}
      getRowKey={(s) => s.site_key}
      emptyMessage="No sites matched your search."
    />
  );
}

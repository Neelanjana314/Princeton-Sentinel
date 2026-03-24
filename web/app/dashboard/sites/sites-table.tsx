"use client";

import Link from "next/link";
import * as React from "react";

import { SortableTable } from "@/components/sortable-table";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatIsoDate, formatIsoDateTime } from "@/app/lib/format";
import { describeAvailabilityReason } from "@/app/lib/site-availability";

type SiteRow = {
  site_key: string;
  site_id: string;
  route_drive_id: string;
  title: string;
  web_url: string | null;
  created_dt: string | null;
  is_personal: boolean | null;
  is_available: boolean | null;
  last_available_at: string | null;
  availability_reason: string | null;
  template: string | null;
  storage_used_bytes: number | null;
  storage_total_bytes: number | null;
  last_activity_dt: string | null;
};

function parseIsoToTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function siteTypeLabel(isPersonalSite: boolean | null): "Personal" | "SharePoint" | "Unknown" {
  if (isPersonalSite == null) return "Unknown";
  return isPersonalSite ? "Personal" : "SharePoint";
}

export function SitesTable({ items }: { items: SiteRow[] }) {
  const columns = React.useMemo(
    () => [
      {
        id: "title",
        header: "Title",
        sortValue: (s: SiteRow) => s.title,
        cell: (s: SiteRow) => (
          <div className="flex flex-col gap-1">
            <Link className="font-medium hover:underline" href={`/sites/${encodeURIComponent(s.route_drive_id)}`}>
              {s.title || s.route_drive_id}
            </Link>
            {s.web_url ? (
              <a className="truncate text-xs text-muted-foreground hover:underline" href={s.web_url} target="_blank" rel="noreferrer">
                {s.web_url}
              </a>
            ) : (
              <span className="truncate text-xs text-muted-foreground">{s.route_drive_id}</span>
            )}
            {s.is_available === false ? (
              <span className="truncate text-xs text-amber-700">{describeAvailabilityReason(s.availability_reason)}</span>
            ) : null}
          </div>
        ),
        cellClassName: "max-w-[420px]",
      },
      {
        id: "type",
        header: "Type",
        sortValue: (s: SiteRow) => siteTypeLabel(s.is_personal),
        cell: (s: SiteRow) => {
          if (s.is_personal == null) return <Badge variant="outline">Unknown</Badge>;
          if (s.is_personal) return <Badge>Personal</Badge>;
          return <Badge variant="outline">SharePoint</Badge>;
        },
      },
      {
        id: "availability",
        header: "Availability",
        sortValue: (s: SiteRow) => (s.is_available === false ? "unavailable" : "available"),
        cell: (s: SiteRow) =>
          s.is_available === false ? (
            <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-900">Unavailable</Badge>
          ) : (
            <Badge variant="outline">Available</Badge>
          ),
      },
      {
        id: "lastAvailable",
        header: "Last available",
        sortValue: (s: SiteRow) => parseIsoToTs(s.last_available_at),
        cell: (s: SiteRow) => <span className="text-muted-foreground">{formatIsoDateTime(s.last_available_at)}</span>,
      },
      {
        id: "template",
        header: "Template",
        sortValue: (s: SiteRow) => s.template ?? "",
        cell: (s: SiteRow) => <span className="text-muted-foreground">{s.template ?? "—"}</span>,
      },
      {
        id: "created",
        header: "Created",
        sortValue: (s: SiteRow) => parseIsoToTs(s.created_dt),
        cell: (s: SiteRow) => <span className="text-muted-foreground">{formatIsoDate(s.created_dt)}</span>,
      },
      {
        id: "storage",
        header: "Storage",
        sortValue: (s: SiteRow) => s.storage_used_bytes,
        cell: (s: SiteRow) => (
          <span className="text-muted-foreground">
            {formatBytes(s.storage_used_bytes)} / {formatBytes(s.storage_total_bytes)}
          </span>
        ),
      },
      {
        id: "lastActivity",
        header: "Last activity",
        sortValue: (s: SiteRow) => parseIsoToTs(s.last_activity_dt),
        cell: (s: SiteRow) => <span className="text-muted-foreground">{formatIsoDateTime(s.last_activity_dt)}</span>,
      },
    ],
    []
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

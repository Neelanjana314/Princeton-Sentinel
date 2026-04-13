"use client";

import * as React from "react";

import { SortableTable } from "@/components/sortable-table";
import { formatIsoDate, formatIsoDateTime } from "@/app/lib/format";

type ActivityPoint = { date: string; modifiedItems: number; shares: number };

type TopUser = {
  userId: string;
  displayName: string | null;
  email: string | null;
  modifiedItems: number;
  lastModifiedDateTime: string | null;
};

function parseIsoToTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max <= 0 ? 0 : Math.min((value / max) * 100, 100);
  return (
    <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="block h-2 w-full overflow-hidden rounded" aria-hidden="true">
      <rect x="0" y="0" width="100" height="8" rx="4" fill="hsl(var(--muted))" />
      <rect x="0" y="0" width={pct} height="8" rx="4" fill="hsl(var(--primary))" />
    </svg>
  );
}

export function SiteActivityTrendTable({
  points,
  maxModified,
  maxShares,
  windowDays,
}: {
  points: ActivityPoint[];
  maxModified: number;
  maxShares: number;
  windowDays: number | null;
}) {
  const windowLabel = windowDays == null ? "All-time" : `${windowDays}d`;
  const columns = React.useMemo(
    () => [
      {
        id: "date",
        header: "Date",
        sortValue: (p: ActivityPoint) => parseIsoToTs(p.date),
        cell: (p: ActivityPoint) => <span className="text-muted-foreground">{formatIsoDate(p.date)}</span>,
      },
      {
        id: "modified",
        header: `Items last modified (${windowLabel})`,
        sortValue: (p: ActivityPoint) => p.modifiedItems,
        cell: (p: ActivityPoint) => (
          <div className="flex items-center gap-3">
            <div className="w-28">
              <Bar value={p.modifiedItems} max={maxModified} />
            </div>
            <span className="tabular-nums text-muted-foreground">{p.modifiedItems}</span>
          </div>
        ),
      },
      {
        id: "shares",
        header: `Link permissions seen (${windowLabel})`,
        sortValue: (p: ActivityPoint) => p.shares,
        cell: (p: ActivityPoint) => (
          <div className="flex items-center gap-3">
            <div className="w-28">
              <Bar value={p.shares} max={maxShares} />
            </div>
            <span className="tabular-nums text-muted-foreground">{p.shares}</span>
          </div>
        ),
      },
    ],
    [windowLabel, maxModified, maxShares]
  );

  return <SortableTable items={points} columns={columns} getRowKey={(p) => p.date} />;
}

export function SiteTopUsersTable({ users }: { users: TopUser[] }) {
  const columns = React.useMemo(
    () => [
      {
        id: "user",
        header: "User",
        sortValue: (u: TopUser) => u.displayName ?? u.email ?? u.userId,
        cell: (u: TopUser) => (
          <div className="flex flex-col">
            <span className="font-medium">{u.displayName ?? u.email ?? u.userId}</span>
            {u.email ? <span className="text-xs text-muted-foreground">{u.email}</span> : null}
          </div>
        ),
      },
      {
        id: "modifiedItems",
        header: "Items last modified",
        sortValue: (u: TopUser) => u.modifiedItems,
        cell: (u: TopUser) => <span className="text-muted-foreground">{u.modifiedItems.toLocaleString()}</span>,
      },
      {
        id: "lastModified",
        header: "Last modified",
        sortValue: (u: TopUser) => parseIsoToTs(u.lastModifiedDateTime),
        cell: (u: TopUser) => <span className="text-muted-foreground">{formatIsoDateTime(u.lastModifiedDateTime)}</span>,
      },
    ],
    []
  );

  return (
    <SortableTable
      items={users}
      columns={columns}
      getRowKey={(u) => u.userId}
      emptyMessage="No user modifications found."
    />
  );
}

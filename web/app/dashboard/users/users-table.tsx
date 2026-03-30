"use client";

import Link from "next/link";
import * as React from "react";

import { SortableTable } from "@/components/sortable-table";
import { formatIsoDateTime } from "@/app/lib/format";

type UserRow = {
  user_id: string;
  display_name: string | null;
  mail: string | null;
  user_principal_name: string | null;
  user_type: string | null;
  department: string | null;
  job_title: string | null;
  synced_at: string | null;
};

function parseIsoToTs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

export function UsersTable({ items }: { items: UserRow[] }) {
  const columns = React.useMemo(
    () => [
      {
        id: "user",
        header: "User",
        sortValue: (u: UserRow) => u.display_name ?? u.mail ?? u.user_principal_name ?? u.user_id,
        cell: (u: UserRow) => (
          <div className="flex flex-col">
            <Link className="font-medium hover:underline" href={`/dashboard/users/${encodeURIComponent(u.user_id)}`}>
              {u.display_name ?? u.mail ?? u.user_principal_name ?? u.user_id}
            </Link>
            <span className="truncate text-xs text-muted-foreground">{u.mail ?? u.user_principal_name ?? u.user_id}</span>
          </div>
        ),
        cellClassName: "max-w-[520px]",
      },
      {
        id: "type",
        header: "User Type",
        sortValue: (u: UserRow) => u.user_type ?? "",
        cell: (u: UserRow) => <span className="text-muted-foreground">{u.user_type ?? "—"}</span>,
      },
      {
        id: "department",
        header: "Department",
        sortValue: (u: UserRow) => u.department ?? "",
        cell: (u: UserRow) => <span className="text-muted-foreground">{u.department ?? "—"}</span>,
      },
      {
        id: "title",
        header: "Job Title",
        sortValue: (u: UserRow) => u.job_title ?? "",
        cell: (u: UserRow) => <span className="text-muted-foreground">{u.job_title ?? "—"}</span>,
      },
      {
        id: "synced",
        header: "Last Synced",
        sortValue: (u: UserRow) => parseIsoToTs(u.synced_at),
        cell: (u: UserRow) => <span className="text-muted-foreground">{formatIsoDateTime(u.synced_at)}</span>,
      },
    ],
    []
  );

  return (
    <SortableTable
      mode="server"
      items={items}
      columns={columns}
      getRowKey={(u) => u.user_id}
      emptyMessage="No users matched your search."
    />
  );
}

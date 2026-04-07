"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const tabs = [
  { label: "Analytics", href: "/admin/analytics" },
  { label: "Jobs", href: "/admin/jobs" },
  { label: "Revoke Activity", href: "/admin/revoke-activity" },
  { label: "Agent Access", href: "/admin/agent-access-logs" },
  { label: "Runs", href: "/admin/runs" },
  { label: "Admin", href: "/admin" },
];

export default function AdminTabs() {
  const pathname = usePathname();

  return (
    <div className="flex flex-wrap gap-2 rounded-lg border bg-card p-2">
      {tabs.map((tab) => {
        const isActive = pathname === tab.href || (tab.href !== "/admin" && pathname.startsWith(tab.href));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "rounded-md border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide",
              isActive ? "border-primary/45 bg-primary/15 text-foreground" : "border-transparent text-muted-foreground hover:bg-accent"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}

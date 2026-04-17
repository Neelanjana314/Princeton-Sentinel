"use client";

import Link from "next/link";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function AgentAccessControl() {
  return (
    <Link
      href="/dashboard/agents/agent-access-control"
      aria-label="Open Agent Access Control"
      className="group block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <Card className="overflow-hidden border-primary/20 bg-gradient-to-r from-card via-card to-muted/30 shadow-sm transition-all duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/40 group-hover:shadow-md group-focus-visible:border-primary/50">
        <CardHeader className="gap-3">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-primary">
                Admin Control
              </span>
              <CardTitle className="text-base sm:text-lg">Agent Access Control</CardTitle>
            </div>

            <span className="inline-flex shrink-0 items-center rounded-md border border-primary/25 bg-background px-3 py-1.5 text-sm font-semibold text-primary shadow-sm transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
              Open controls
            </span>
          </div>

          <CardDescription>
            Block and unblock individual users from specific agents, and view agent-user access assignments
          </CardDescription>

          <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-3 text-sm">
            <span className="font-medium text-foreground">Manage agent-specific access rules</span>
            <span className="font-semibold text-primary transition-transform duration-150 group-hover:translate-x-0.5">
              View details &gt;
            </span>
          </div>
        </CardHeader>
      </Card>
    </Link>
  );
}

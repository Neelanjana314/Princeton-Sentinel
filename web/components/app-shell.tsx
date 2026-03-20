"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import type { FeatureFlags } from "@/app/lib/feature-flags-config";
import { matchesFeaturePath } from "@/app/lib/feature-flags-config";
import UserMenu from "@/components/user-menu";
import { FeatureFlagsProvider, useFeatureFlags } from "@/components/feature-flags-provider";
import { cn } from "@/lib/utils";

const LOGO_HEIGHT = 36;
const LOGO_WIDTH = 135;

type AppShellProps = {
  userLabel: string;
  canAdmin: boolean;
  initialFeatureFlags: FeatureFlags;
  initialFeatureFlagVersion: string | null;
  children: React.ReactNode;
};

function AppShellContent({ userLabel, canAdmin, children }: Omit<AppShellProps, "initialFeatureFlags" | "initialFeatureFlagVersion">) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { flags } = useFeatureFlags();
  const navItems = [
    { href: "/dashboard", label: "Overview", active: pathname === "/dashboard" },
    { href: "/dashboard/sites", label: "Sites", active: pathname.startsWith("/dashboard/sites") || pathname.startsWith("/sites") },
    { href: "/dashboard/activity", label: "Activity", active: pathname.startsWith("/dashboard/activity") },
    { href: "/dashboard/sharing", label: "Sharing", active: pathname.startsWith("/dashboard/sharing") },
    { href: "/dashboard/risk", label: "Risk", active: pathname.startsWith("/dashboard/risk") },
    { href: "/dashboard/users", label: "Users", active: pathname.startsWith("/dashboard/users") },
    { href: "/dashboard/groups", label: "Groups", active: pathname.startsWith("/dashboard/groups") },
    { href: "/dashboard/agents", label: "Agents", active: pathname.startsWith("/dashboard/agents") || pathname.startsWith("/dashboard/copilot") },
  ].filter((item) => (item.href === "/dashboard/agents" ? flags.agents_dashboard : true));

  useEffect(() => {
    if (flags.agents_dashboard) {
      return;
    }
    if (matchesFeaturePath("agents_dashboard", pathname)) {
      router.replace("/dashboard");
      router.refresh();
    }
  }, [flags.agents_dashboard, pathname, router]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/dashboard" className="flex items-center gap-3 text-sm font-semibold text-foreground">
              <Image src="/pis-logo.png" alt="Princeton ITS logo" width={LOGO_WIDTH} height={LOGO_HEIGHT} priority className="h-16 w-auto" />
              <span className="hidden whitespace-nowrap text-base sm:inline">Princeton Sentinel</span>
            </Link>
            <nav className="hidden flex-wrap items-center gap-1 lg:flex">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide",
                    item.active
                      ? "border-primary/45 bg-primary/15 text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground"
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <UserMenu userLabel={userLabel} canAdmin={canAdmin} />
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-7xl gap-1 overflow-x-auto px-4 pb-2 lg:hidden">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "whitespace-nowrap rounded-md border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
                item.active
                  ? "border-primary/45 bg-primary/15 text-foreground"
                  : "border-transparent text-muted-foreground"
              )}
            >
              {item.label}
            </Link>
          ))}
        </div>
      </header>
      <div className="mx-auto w-full max-w-7xl px-4 py-5 lg:px-6">{children}</div>
    </div>
  );
}

export default function AppShell({
  userLabel,
  canAdmin,
  initialFeatureFlags,
  initialFeatureFlagVersion,
  children,
}: AppShellProps) {
  return (
    <FeatureFlagsProvider initialFlags={initialFeatureFlags} initialVersion={initialFeatureFlagVersion}>
      <AppShellContent userLabel={userLabel} canAdmin={canAdmin}>
        {children}
      </AppShellContent>
    </FeatureFlagsProvider>
  );
}

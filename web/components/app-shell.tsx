"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import {
  FEATURE_DISABLED_MESSAGE,
  FEATURE_DISABLED_REDIRECT_DELAY_MS,
  FEATURE_DISABLED_REDIRECT_TARGET,
  shouldRedirectImmediatelyForDisabledFeature,
  shouldRedirectForDisabledFeature,
} from "@/app/lib/feature-flags-client";
import type { FeatureFlags } from "@/app/lib/feature-flags-config";
import { matchesFeaturePath } from "@/app/lib/feature-flags-config";
import BrandLogo from "@/components/brand-logo";
import UserMenu from "@/components/user-menu";
import { FeatureFlagsProvider, useFeatureFlags } from "@/components/feature-flags-provider";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const LOGO_HEIGHT = 36;
const LOGO_WIDTH = 135;

type AppShellProps = {
  userLabel: string;
  canAdmin: boolean;
  initialFeatureFlags: FeatureFlags;
  initialFeatureFlagVersion: string | null;
  csrfToken: string;
  showLocalTesting: boolean;
  emulateLicenseEnabled: boolean;
  children: React.ReactNode;
};

type AppShellContentProps = {
  userLabel: string;
  canAdmin: boolean;
  showLocalTesting: boolean;
  children: React.ReactNode;
};

function AppShellContent({
  userLabel,
  canAdmin,
  showLocalTesting,
  children,
}: AppShellContentProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const { flags } = useFeatureFlags();
  const [featureDisabledNotice, setFeatureDisabledNotice] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const previousFlagsRef = useRef(flags);
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileNavRef = useRef<HTMLDivElement | null>(null);
  const navItems = [
    { href: "/dashboard", label: "Overview", active: pathname === "/dashboard" },
    { href: "/dashboard/sites", label: "SharePoint Sites", active: pathname.startsWith("/dashboard/sites") || pathname.startsWith("/sites") },
    { href: "/dashboard/activity", label: "Activity", active: pathname.startsWith("/dashboard/activity") },
    { href: "/dashboard/sharing", label: "Sharing", active: pathname.startsWith("/dashboard/sharing") },
    { href: "/dashboard/risk", label: "Risk", active: pathname.startsWith("/dashboard/risk") },
    { href: "/dashboard/users", label: "Users", active: pathname.startsWith("/dashboard/users") },
    { href: "/dashboard/groups", label: "Groups", active: pathname.startsWith("/dashboard/groups") },
    { href: "/dashboard/copilot", label: "Copilot", active: pathname.startsWith("/dashboard/copilot") },
    { href: "/dashboard/agents", label: "Agents", active: pathname.startsWith("/dashboard/agents") },
  ].filter((item) => {
    if (item.href === "/dashboard/agents") return flags.agents_dashboard;
    if (item.href === "/dashboard/copilot") return flags.copilot_dashboard;
    return true;
  });

  useEffect(() => {
    const previousFlags = previousFlagsRef.current;

    if (shouldRedirectForDisabledFeature(previousFlags, flags, pathname)) {
      setFeatureDisabledNotice(FEATURE_DISABLED_MESSAGE);
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
      }
      redirectTimerRef.current = setTimeout(() => {
        router.replace(FEATURE_DISABLED_REDIRECT_TARGET);
        router.refresh();
      }, FEATURE_DISABLED_REDIRECT_DELAY_MS);
    } else if (shouldRedirectImmediatelyForDisabledFeature(flags, pathname)) {
      setFeatureDisabledNotice(null);
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
      router.replace(FEATURE_DISABLED_REDIRECT_TARGET);
      router.refresh();
    } else if (flags.agents_dashboard || !matchesFeaturePath("agents_dashboard", pathname)) {
      setFeatureDisabledNotice(null);
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
    }

    previousFlagsRef.current = flags;
  }, [flags, pathname, router]);

  useEffect(
    () => () => {
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
      }
    },
    []
  );

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (!mobileNavRef.current) return;
      if (!mobileNavRef.current.contains(event.target as Node)) {
        setMobileNavOpen(false);
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMobileNavOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/90">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 px-4 py-3 lg:px-6">
          <div className="flex min-w-0 items-center gap-4">
            <Link href="/dashboard" className="flex items-center gap-3 text-sm font-semibold text-foreground">
              <BrandLogo alt="Princeton ITS logo" width={LOGO_WIDTH} height={LOGO_HEIGHT} priority className="h-16 w-auto" />
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
            <UserMenu
              userLabel={userLabel}
              canAdmin={canAdmin}
              showLocalTesting={showLocalTesting}
            />
            <div className="relative lg:hidden" ref={mobileNavRef}>
              <button
                type="button"
                className="flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background hover:bg-accent"
                onClick={() => setMobileNavOpen((prev) => !prev)}
                aria-haspopup="menu"
                aria-expanded={mobileNavOpen}
                aria-controls="mobile-nav-menu"
              >
                <span className="sr-only">Toggle navigation menu</span>
                <span className="flex flex-col gap-1">
                  <span className="block h-0.5 w-4 rounded-full bg-foreground" />
                  <span className="block h-0.5 w-4 rounded-full bg-foreground" />
                  <span className="block h-0.5 w-4 rounded-full bg-foreground" />
                </span>
              </button>
              {mobileNavOpen ? (
                <div
                  id="mobile-nav-menu"
                  role="menu"
                  className="absolute right-0 z-50 mt-2 w-56 rounded-md border bg-card p-1 text-sm shadow-md"
                >
                  <nav className="flex flex-col gap-1">
                    {navItems.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        role="menuitem"
                        className={cn(
                          "block rounded px-3 py-2 text-sm font-medium",
                          item.active
                            ? "border border-primary/45 bg-primary/15 text-foreground"
                            : "text-muted-foreground hover:bg-accent hover:text-foreground"
                        )}
                        onClick={() => setMobileNavOpen(false)}
                      >
                        {item.label}
                      </Link>
                    ))}
                  </nav>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-5 lg:px-6">
        {featureDisabledNotice ? (
          <Card className="mb-4 border-amber-500/30 bg-amber-500/5">
            <CardContent className="pt-6 text-sm text-foreground">
              <span className="font-semibold">Feature disabled.</span> {featureDisabledNotice}
            </CardContent>
          </Card>
        ) : null}
        {children}
      </main>
      <footer className="border-t bg-card/70">
        <div className="mx-auto grid w-full max-w-7xl gap-3 px-4 py-4 text-xs text-muted-foreground sm:grid-cols-3 sm:items-center lg:px-6">
          <div className="flex flex-col gap-1">
            <p>Copyright 2026.</p>
            <p>All Rights Reserved.</p>
          </div>
          <p className="text-center">Princeton Sentinel powered by Princeton IT Services</p>
          <address className="flex flex-col gap-1 not-italic sm:items-end">
            <span>Address 500 Alexander Park, #201, Princeton, NJ 08540</span>
            <a className="hover:text-foreground" href="mailto:support.sentinel@princetonits.com">
              Support Email: support.sentinel@princetonits.com
            </a>
            <a className="hover:text-foreground" href="tel:+17328324365">
              Phone Number: +1 732-TECH-365
            </a>
          </address>
        </div>
      </footer>
    </div>
  );
}

export default function AppShell({
  userLabel,
  canAdmin,
  initialFeatureFlags,
  initialFeatureFlagVersion,
  showLocalTesting,
  children,
}: AppShellProps) {
  return (
    <FeatureFlagsProvider initialFlags={initialFeatureFlags} initialVersion={initialFeatureFlagVersion}>
      <AppShellContent
        userLabel={userLabel}
        canAdmin={canAdmin}
        showLocalTesting={showLocalTesting}
      >
        {children}
      </AppShellContent>
    </FeatureFlagsProvider>
  );
}

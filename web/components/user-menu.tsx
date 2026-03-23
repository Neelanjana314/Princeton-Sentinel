"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

type UserMenuProps = {
  userLabel: string;
  canAdmin: boolean;
};

export default function UserMenu({ userLabel, canAdmin }: UserMenuProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"light" | "dark">("light");
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pathname = usePathname() ?? "/dashboard";
  const searchParams = useSearchParams();
  const query = searchParams?.toString();
  const callbackUrl = `${pathname}${query ? `?${query}` : ""}`;
  const signOutUrl = `/signout?callbackUrl=${encodeURIComponent(callbackUrl)}`;

  useEffect(() => {
    const isDark = document.documentElement.classList.contains("dark");
    setMode(isDark ? "dark" : "light");

    function handleClick(event: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
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
    <div className="relative" ref={wrapperRef}>
      <button
        type="button"
        className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-1.5 text-sm hover:bg-accent"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="max-w-40 truncate text-sm text-muted-foreground">{userLabel}</span>
        <span className="text-xs text-muted-foreground">▾</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-44 rounded-md border bg-card p-1 text-sm shadow-md"
        >
          {canAdmin ? (
            <>
              <Link
                href="/license"
                role="menuitem"
                className="block rounded px-3 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                License
              </Link>
              <Link
                href="/admin"
                role="menuitem"
                className="block rounded px-3 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setOpen(false)}
              >
                Admin
              </Link>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="block w-full rounded px-3 py-2 text-left text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => {
              const next: "light" | "dark" = mode === "dark" ? "light" : "dark";
              document.documentElement.classList.toggle("dark", next === "dark");
              localStorage.setItem("ps-theme", next);
              setMode(next);
              setOpen(false);
            }}
          >
            Theme: {mode === "dark" ? "Dark" : "Light"}
          </button>
          <Link
            href={signOutUrl}
            role="menuitem"
            className="block rounded px-3 py-2 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => setOpen(false)}
          >
            Logout
          </Link>
        </div>
      ) : null}
    </div>
  );
}

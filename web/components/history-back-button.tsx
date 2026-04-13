"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

export function navigateBack(
  router: Pick<ReturnType<typeof useRouter>, "back" | "push">,
  historyLength: number | undefined,
  fallbackHref: string
) {
  if (typeof historyLength === "number" && historyLength > 1) {
    router.back();
    return;
  }

  router.push(fallbackHref);
}

type HistoryBackButtonProps = {
  fallbackHref: string;
  className?: string;
  children?: React.ReactNode;
};

export function HistoryBackButton({
  fallbackHref,
  className,
  children = "Back",
}: HistoryBackButtonProps) {
  const router = useRouter();

  return (
    <button
      type="button"
      className={className}
      onClick={() => navigateBack(router, typeof window === "undefined" ? undefined : window.history.length, fallbackHref)}
    >
      {children}
    </button>
  );
}

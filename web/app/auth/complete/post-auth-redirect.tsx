"use client";

import { useEffect } from "react";

const AUTH_WARMUP_PATH = "/api/auth/warmup";
const MAX_WARMUP_WAIT_MS = 900;

export function PostAuthRedirect({ callbackUrl }: { callbackUrl: string }) {
  useEffect(() => {
    let active = true;
    const timeoutId = window.setTimeout(() => {
      if (active) {
        window.location.replace(callbackUrl);
      }
    }, MAX_WARMUP_WAIT_MS);

    void (async () => {
      try {
        await fetch(AUTH_WARMUP_PATH, {
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          keepalive: true,
        });
      } catch {
        // Warmup is opportunistic; continue the redirect even if it fails.
      } finally {
        if (!active) {
          return;
        }
        window.clearTimeout(timeoutId);
        window.location.replace(callbackUrl);
      }
    })();

    return () => {
      active = false;
      window.clearTimeout(timeoutId);
    };
  }, [callbackUrl]);

  return null;
}

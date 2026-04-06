"use client";

import { useEffect } from "react";

export function PostAuthRedirect({ callbackUrl }: { callbackUrl: string }) {
  useEffect(() => {
    window.location.replace(callbackUrl);
  }, [callbackUrl]);

  return null;
}

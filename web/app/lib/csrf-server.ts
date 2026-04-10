import { cookies, headers } from "next/headers";

import { CSRF_REQUEST_TOKEN_HEADER, ensureCsrfToken, getCsrfCookieName } from "@/app/lib/csrf";

export async function getCsrfRenderToken() {
  const requestHeaders = await headers();
  const headerToken = requestHeaders.get(CSRF_REQUEST_TOKEN_HEADER);
  if (headerToken) {
    return headerToken;
  }

  const cookieStore = await cookies();
  return ensureCsrfToken(cookieStore.get(getCsrfCookieName())?.value);
}

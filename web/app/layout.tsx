import { cookies, headers } from "next/headers";

import "./globals.css";
import { NONCE_HEADER } from "@/app/lib/security-headers";
import { normalizeTheme, THEME_COOKIE_MAX_AGE, THEME_COOKIE_NAME, THEME_STORAGE_KEY } from "@/app/lib/theme";

export const metadata = {
  title: "Princeton Sentinel",
  description: "Data posture dashboard for Microsoft 365",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  const cookieTheme = normalizeTheme(cookieStore.get(THEME_COOKIE_NAME)?.value);
  const nonce = requestHeaders.get(NONCE_HEADER) ?? undefined;
  const themeInitScript = `
    (function() {
      try {
        var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
        if (stored !== "light" && stored !== "dark") stored = null;
        var cookieTheme = ${JSON.stringify(cookieTheme)};
        var prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        var mode = stored || cookieTheme || (prefersDark ? "dark" : "light");
        var root = document.documentElement;
        root.classList.toggle("dark", mode === "dark");
        localStorage.setItem("${THEME_STORAGE_KEY}", mode);
        document.cookie = "${THEME_COOKIE_NAME}=" + mode + "; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax";
      } catch (e) {}
    })();
  `;

  return (
    <html
      lang="en"
      className={cookieTheme === "dark" ? "dark" : undefined}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

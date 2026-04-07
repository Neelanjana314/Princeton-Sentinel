import Link from "next/link";

import BrandLogo from "@/components/brand-logo";

type AuthShellProps = {
  title: string;
  subtitle?: string;
  support?: React.ReactNode;
  children: React.ReactNode;
};

const LOGO_HEIGHT = 36;
const LOGO_WIDTH = 135;

export default function AuthShell({ title, subtitle, support, children }: AuthShellProps) {
  return (
    <div className="ps-auth-shell">
      <header className="ps-auth-header">
        <div className="mx-auto flex w-full max-w-7xl items-center px-4 py-3 lg:px-6">
          <Link href="/" className="flex items-center gap-3 text-sm font-semibold text-foreground">
            <BrandLogo alt="Princeton ITS logo" width={LOGO_WIDTH} height={LOGO_HEIGHT} priority className="h-8 w-auto" />
            <span className="hidden whitespace-nowrap text-base sm:inline">Princeton Sentinel</span>
          </Link>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 items-center justify-center px-4 py-8 lg:px-6 lg:py-10">
        <section className="ps-auth-card">
          <div className="space-y-2 border-b border-border pb-4">
            {support ? <p className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{support}</p> : null}
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="pt-5">{children}</div>
        </section>
      </main>
    </div>
  );
}

import AdminTabs from "@/app/admin/AdminTabs";
import AdminVersionBadge from "@/app/admin/AdminVersionBadge";
import { isAdmin, requireAdmin } from "@/app/lib/auth";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import { getAppVersion } from "@/app/lib/version";
import AppShell from "@/components/app-shell";
import PageHeader from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { session, groups } = await requireAdmin();
  const userLabel = session.user?.name ?? session.user?.email ?? "Signed in";
  const canAdmin = isAdmin(groups);
  const appVersion = getAppVersion();
  const featureFlagsPayload = await getFeatureFlagsPayload();

  return (
    <AppShell
      userLabel={userLabel}
      canAdmin={canAdmin}
      initialFeatureFlags={featureFlagsPayload.flags}
      initialFeatureFlagVersion={featureFlagsPayload.version}
    >
      <main className="ps-page">
        <PageHeader
          title="Admin"
          subtitle="Operations and controls for ingestion, schedules, and worker health."
          actions={<AdminVersionBadge version={appVersion} />}
        />
        <AdminTabs />
        {children}
      </main>
    </AppShell>
  );
}

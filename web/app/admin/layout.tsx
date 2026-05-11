import AdminTabs from "@/app/admin/AdminTabs";
import AdminVersionBadge from "@/app/admin/AdminVersionBadge";
import { getAdminSubtitle } from "@/app/admin/copy";
import { isAdmin, requireAdmin } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import { getLocalTestingMenuState } from "@/app/lib/local-testing-state";
import { getAppVersion } from "@/app/lib/version";
import AppShell from "@/components/app-shell";
import PageHeader from "@/components/page-header";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { session, groups } = await requireAdmin();
  const userLabel = session.user?.name ?? session.user?.email ?? "Signed in";
  const canAdmin = isAdmin(groups);
  const appVersion = getAppVersion();
  const [featureFlagsPayload, localTestingMenuState, csrfToken] = await Promise.all([
    getFeatureFlagsPayload(),
    getLocalTestingMenuState(),
    getCsrfRenderToken(),
  ]);
  const subtitle = getAdminSubtitle(featureFlagsPayload.flags.test_mode);

  return (
    <AppShell
      userLabel={userLabel}
      canAdmin={canAdmin}
      initialFeatureFlags={featureFlagsPayload.flags}
      initialFeatureFlagVersion={featureFlagsPayload.version}
      csrfToken={csrfToken}
      showLocalTesting={localTestingMenuState.visible}
      emulateLicenseEnabled={localTestingMenuState.emulateLicenseEnabled}
    >
      <main className="ps-page">
        <PageHeader
          title="Admin"
          subtitle={subtitle}
          actions={<AdminVersionBadge version={appVersion} />}
        />
        <AdminTabs />
        {children}
      </main>
    </AppShell>
  );
}

import { redirect } from "next/navigation";

import { getSession, getGroupsFromSession, isAdmin, isUser } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import { getLocalTestingMenuState } from "@/app/lib/local-testing-state";
import AppShell from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function SitesLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const groups = getGroupsFromSession(session);
  const canUser = session ? isUser(groups) : false;
  const canAdmin = session ? isAdmin(groups) : false;

  if (!session?.user) {
    redirect("/signin/account?callbackUrl=/sites");
  }

  if (!canUser) {
    redirect("/forbidden");
  }

  const userLabel = session.user.name ?? session.user.email ?? "Signed in";
  const [featureFlagsPayload, localTestingMenuState, csrfToken] = await Promise.all([
    getFeatureFlagsPayload(),
    getLocalTestingMenuState(),
    getCsrfRenderToken(),
  ]);

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
      {children}
    </AppShell>
  );
}

import { redirect } from "next/navigation";
import { getSession, getGroupsFromSession, isAdmin, isUser } from "@/app/lib/auth";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import AppShell from "@/components/app-shell";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const groups = getGroupsFromSession(session);
  const canUser = session ? isUser(groups) : false;
  const canAdmin = session ? isAdmin(groups) : false;

  if (!session?.user) {
    redirect("/signin/account?callbackUrl=/dashboard");
  }

  if (!canUser) {
    redirect("/forbidden");
  }

  const userLabel = session.user.name ?? session.user.email ?? "Signed in";
  const featureFlagsPayload = await getFeatureFlagsPayload();

  return (
    <AppShell
      userLabel={userLabel}
      canAdmin={canAdmin}
      initialFeatureFlags={featureFlagsPayload.flags}
      initialFeatureFlagVersion={featureFlagsPayload.version}
    >
      {children}
    </AppShell>
  );
}

import { notFound } from "next/navigation";

import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireUser, isAdmin } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import { getCurrentLicenseSummary } from "@/app/lib/license";
import { getLocalTestingMenuState } from "@/app/lib/local-testing-state";
import AppShell from "@/components/app-shell";
import CsrfHiddenInput from "@/components/csrf-hidden-input";
import PageHeader from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

async function TestingPageContent() {
  const [{ session, groups }, featureFlagsPayload, localTestingMenuState, csrfToken, licenseSummary] = await Promise.all([
    requireUser(),
    getFeatureFlagsPayload(),
    getLocalTestingMenuState(),
    getCsrfRenderToken(),
    getCurrentLicenseSummary(),
  ]);

  if (!localTestingMenuState.visible) {
    notFound();
  }

  const userLabel = session.user?.name ?? session.user?.email ?? "Signed in";
  const canAdmin = await isAdmin(groups);
  const emulateLicenseEnabled = localTestingMenuState.emulateLicenseEnabled;

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
          title="Testing"
          subtitle="Local Docker-only controls for emulating runtime behavior during development and demos."
        />

        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle>License Emulation</CardTitle>
                <Badge variant={emulateLicenseEnabled ? "default" : "outline"}>
                  {emulateLicenseEnabled ? "Enabled" : "Disabled"}
                </Badge>
              </div>
              <CardDescription>
                This section is structured for future testing controls. For now it only manages the effective license state.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
                <div>
                  Effective status: <span className="font-medium text-foreground">{licenseSummary.status}</span>
                </div>
                <div>
                  Effective mode: <span className="font-medium text-foreground">{licenseSummary.mode}</span>
                </div>
                <div>
                  Behavior:
                  {" "}
                  {emulateLicenseEnabled
                    ? "Synthetic full license with no expiry and all features enabled."
                    : "Missing license fallback with read-only behavior."}
                </div>
              </div>

              <form action="/api/local-testing/license" method="post" className="flex flex-wrap items-center gap-3">
                <CsrfHiddenInput token={csrfToken} />
                <input type="hidden" name="callbackUrl" value="/testing" />
                <input type="hidden" name="emulateLicenseEnabled" value={emulateLicenseEnabled ? "false" : "true"} />
                <Button type="submit">
                  {emulateLicenseEnabled ? "Disable Emulated License" : "Enable Emulated License"}
                </Button>
                <span className="text-sm text-muted-foreground">
                  Current value: {emulateLicenseEnabled ? "License Enabled" : "License Disabled"}
                </span>
              </form>
            </CardContent>
          </Card>
        </div>
      </main>
    </AppShell>
  );
}

export default withPageRequestTiming("/testing", TestingPageContent);

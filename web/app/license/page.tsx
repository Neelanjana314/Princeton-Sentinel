import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireAdmin, isAdmin } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import { getLocalTestingMenuState } from "@/app/lib/local-testing-state";
import { getCurrentLicenseSummary, type LicenseFeatureKey } from "@/app/lib/license";
import { type SearchParams } from "@/app/lib/params";
import AppShell from "@/components/app-shell";
import CsrfHiddenInput from "@/components/csrf-hidden-input";
import PageHeader from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import LocalDateTime from "@/components/local-date-time";

export const dynamic = "force-dynamic";

type LicensePageProps = {
  searchParams?: Promise<SearchParams>;
};

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return typeof value === "string" && value ? value : null;
}

function statusBadgeClass(status: string) {
  if (status === "active") {
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-900";
  }
  if (status === "expired") {
    return "border-amber-500/40 bg-amber-500/15 text-amber-900";
  }
  if (status === "missing") {
    return "border-slate-400/40 bg-slate-400/10 text-foreground";
  }
  return "border-red-500/40 bg-red-500/15 text-red-900";
}

const FEATURE_ORDER: LicenseFeatureKey[] = [
  "dashboard_read",
  "live_graph_read",
  "admin_view",
  "license_manage",
  "permission_revoke",
  "job_control",
  "graph_ingest",
  "copilot_telemetry",
  "agents_dashboard",
];

async function LicensePage({ searchParams }: LicensePageProps) {
  const [{ session, groups }, featureFlagsPayload, summary, localTestingMenuState, csrfToken] = await Promise.all([
    requireAdmin(),
    getFeatureFlagsPayload(),
    getCurrentLicenseSummary(),
    getLocalTestingMenuState(),
    getCsrfRenderToken(),
  ]);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;

  const userLabel = session.user?.name ?? session.user?.email ?? "Signed in";
  const canAdmin = isAdmin(groups);
  const uploadSuccess = readParam(resolvedSearchParams?.uploaded) === "1";
  const uploadStatus = readParam(resolvedSearchParams?.status);
  const clearedSuccess = readParam(resolvedSearchParams?.cleared) === "1";
  const uploadError = readParam(resolvedSearchParams?.error);

  const currentLicenseNotice =
    summary.status === "invalid"
      ? "Current license is invalid. The uploaded artifact is still stored as current, but the app remains in read-only mode."
      : summary.status === "expired"
        ? "Current license is expired. The artifact is stored as current, but write features stay disabled."
        : summary.status === "missing"
          ? "There is no active license right now."
          : null;
  const currentLicenseNoticeClass =
    summary.status === "missing"
      ? "border-slate-400/30 bg-slate-400/5"
      : summary.status === "expired"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-red-500/30 bg-red-500/5";

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
          title="License"
          subtitle="Verify the active signed license artifact, replace it with a new upload, or clear it for demos."
        />

        <div className="grid gap-4">
          {clearedSuccess ? (
            <Card className="border-amber-500/30 bg-amber-500/5">
              <CardContent className="pt-6 text-sm text-foreground">Active license removed for demo purposes.</CardContent>
            </Card>
          ) : null}
          {uploadSuccess ? (
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardContent className="pt-6 text-sm text-foreground">
                {uploadStatus === "active"
                  ? "Current license updated successfully."
                  : uploadStatus === "expired"
                    ? "Uploaded license is now current, but it is expired and the app remains read-only."
                    : "Uploaded license is now current, but it is invalid and the app remains read-only."}
              </CardContent>
            </Card>
          ) : null}
          {uploadError ? (
            <Card className="border-red-500/30 bg-red-500/5">
              <CardContent className="pt-6 text-sm text-foreground">Upload failed: {uploadError}</CardContent>
            </Card>
          ) : null}
          {currentLicenseNotice ? (
            <Card className={currentLicenseNoticeClass}>
              <CardContent className="pt-6 text-sm text-foreground">{currentLicenseNotice}</CardContent>
            </Card>
          ) : null}

          <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>Current License</CardTitle>
                  <Badge className={statusBadgeClass(summary.status)}>{summary.status}</Badge>
                  <Badge variant="outline">{summary.verificationStatus}</Badge>
                </div>
                <CardDescription>The app recomputes this view by parsing and verifying the active signed artifact.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">License Type</div>
                    <div className="mt-1 text-sm font-semibold text-foreground">{summary.payload?.license_type || "--"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Tenant ID</div>
                    <div className="mt-1 break-all font-mono text-xs text-foreground">{summary.payload?.tenant_id || "--"}</div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Expires</div>
                    <div className="mt-1 text-sm text-foreground">
                      <LocalDateTime value={summary.payload?.expires_at || null} fallback="No expiry" />
                    </div>
                  </div>
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">Artifact SHA-256</div>
                    <div className="mt-1 break-all font-mono text-[11px] text-foreground">{summary.sha256 || "--"}</div>
                  </div>
                </div>

                <div className="grid gap-2 text-sm text-muted-foreground">
                  <div>
                    Uploaded:
                    {" "}
                    <LocalDateTime value={summary.uploadedAt} fallback="Never" />
                  </div>
                  <div>Uploaded by: {summary.uploadedBy.name || summary.uploadedBy.upn || summary.uploadedBy.oid || "--"}</div>
                  <div>Artifact ID: <span className="font-mono text-xs text-foreground">{summary.artifactId || "--"}</span></div>
                  <div>Mode: <span className="text-foreground">{summary.mode}</span></div>
                  {summary.verificationError ? <div className="text-red-700">Verification error: {summary.verificationError}</div> : null}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Upload New License</CardTitle>
                <CardDescription>Only the signed artifact is trusted. Every upload replaces the current artifact, even when verification fails.</CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <form action="/api/license" method="post" encType="multipart/form-data" className="grid gap-3">
                  <CsrfHiddenInput token={csrfToken} />
                  <label className="text-sm font-medium text-foreground" htmlFor="license_file">
                    License file
                  </label>
                  <Input id="license_file" name="license_file" type="file" required />
                  <Button type="submit">Upload License</Button>
                </form>
                <div className="border-t pt-4">
                  <div className="mb-2 text-sm font-medium text-foreground">Demo Only</div>
                  <p className="mb-3 text-sm text-muted-foreground">Remove the current license without deleting stored artifact history.</p>
                  <form action="/api/license" method="post">
                    <CsrfHiddenInput token={csrfToken} />
                    <input type="hidden" name="intent" value="clear" />
                    <Button type="submit" variant="outline">Remove Current License</Button>
                  </form>
                </div>
              </CardContent>
            </Card>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>Derived Features</CardTitle>
              <CardDescription>These are the effective features after verification, tenant binding, and expiry handling.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {FEATURE_ORDER.map((featureKey) => (
                <Badge
                  key={featureKey}
                  variant={summary.features[featureKey] ? "default" : "outline"}
                  className={summary.features[featureKey] ? "" : "opacity-70"}
                >
                  {featureKey}: {summary.features[featureKey] ? "on" : "off"}
                </Badge>
              ))}
            </CardContent>
          </Card>
        </div>
      </main>
    </AppShell>
  );
}

export default withPageRequestTiming("/license", LicensePage);

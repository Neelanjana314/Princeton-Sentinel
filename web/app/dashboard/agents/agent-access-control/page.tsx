import { redirectIfFeatureDisabled } from "@/app/lib/feature-flags";
import { requireAdmin } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { getCurrentLicenseSummary } from "@/app/lib/license";
import { withPageRequestTiming } from "@/app/lib/request-timing";
import { getRuntimeEnv } from "@/app/lib/runtime-env";
import AgentAccessControlClient from "./agent-access-control-client";

async function AgentAccessControlPage() {
  await requireAdmin();
  await redirectIfFeatureDisabled("agents_dashboard");
  const [csrfToken, licenseSummary, columnPrefix] = await Promise.all([
    getCsrfRenderToken(),
    getCurrentLicenseSummary(),
    getRuntimeEnv("DATAVERSE_COLUMN_PREFIX"),
  ]);
  const canManageAccess = licenseSummary.features.job_control;
  const controlsDisabledReason =
    !canManageAccess
      ? "Block and unblock controls are unavailable until a valid license with access management permissions is active."
      : null;

  return (
    <AgentAccessControlClient
      csrfToken={csrfToken}
      columnPrefix={columnPrefix || ""}
      canManageAccess={canManageAccess}
      controlsDisabledReason={controlsDisabledReason}
    />
  );
}

export default withPageRequestTiming("/dashboard/agents/agent-access-control", AgentAccessControlPage);

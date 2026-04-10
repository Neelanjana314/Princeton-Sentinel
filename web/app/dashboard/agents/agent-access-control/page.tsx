import { redirectIfFeatureDisabled } from "@/app/lib/feature-flags";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { withPageRequestTiming } from "@/app/lib/request-timing";
import AgentAccessControlClient from "./agent-access-control-client";

async function AgentAccessControlPage() {
  await redirectIfFeatureDisabled("agents_dashboard");
  const csrfToken = await getCsrfRenderToken();
  return <AgentAccessControlClient csrfToken={csrfToken} />;
}

export default withPageRequestTiming("/dashboard/agents/agent-access-control", AgentAccessControlPage);

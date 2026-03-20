import { redirect } from "next/navigation";

import { redirectIfFeatureDisabled } from "@/app/lib/feature-flags";

export default async function CopilotDashboardRedirectPage() {
  await redirectIfFeatureDisabled("agents_dashboard");
  redirect("/dashboard/agents");
}

import { redirect } from "next/navigation";

export default function CopilotDashboardRedirectPage() {
  redirect("/dashboard/agents");
}

import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireAdmin } from "@/app/lib/auth";
import { getCsrfRenderToken } from "@/app/lib/csrf-server";
import { getAdminJobControlState } from "@/app/admin/job-control";
import AdminOverviewClient from "@/app/admin/AdminOverviewClient";

async function AdminPage() {
  await requireAdmin();
  const initialAdminJobControl = await getAdminJobControlState();
  const csrfToken = await getCsrfRenderToken();
  return <AdminOverviewClient initialAdminJobControl={initialAdminJobControl} csrfToken={csrfToken} />;
}

export default withPageRequestTiming("/admin", AdminPage);

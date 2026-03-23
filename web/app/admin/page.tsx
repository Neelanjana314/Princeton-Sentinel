import { withPageRequestTiming } from "@/app/lib/request-timing";
import { requireAdmin } from "@/app/lib/auth";
import { getAdminJobControlState } from "@/app/admin/job-control";
import AdminOverviewClient from "@/app/admin/AdminOverviewClient";

async function AdminPage() {
  await requireAdmin();
  const initialAdminJobControl = await getAdminJobControlState();
  return <AdminOverviewClient initialAdminJobControl={initialAdminJobControl} />;
}

export default withPageRequestTiming("/admin", AdminPage);

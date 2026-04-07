import { withPageRequestTiming } from "@/app/lib/request-timing";
import DataverseTableClient from "./dataverse-table-client";

function DataverseTablePage() {
  return <DataverseTableClient />;
}

export default withPageRequestTiming("/dashboard/agents/dataverse", DataverseTablePage);

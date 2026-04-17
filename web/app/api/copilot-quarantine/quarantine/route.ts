import { withApiRequestTiming } from "@/app/lib/request-timing";
import { handleCopilotQuarantineAction } from "../shared";

export const dynamic = "force-dynamic";

const quarantineHandler = async function POST(req: Request) {
  return handleCopilotQuarantineAction(req, "quarantine");
};

export const POST = withApiRequestTiming("/api/copilot-quarantine/quarantine", quarantineHandler);

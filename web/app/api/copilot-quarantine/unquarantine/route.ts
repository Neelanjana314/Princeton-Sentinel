import { withApiRequestTiming } from "@/app/lib/request-timing";
import { handleCopilotQuarantineAction } from "../shared";

export const dynamic = "force-dynamic";

const unquarantineHandler = async function POST(req: Request) {
  return handleCopilotQuarantineAction(req, "unquarantine");
};

export const POST = withApiRequestTiming("/api/copilot-quarantine/unquarantine", unquarantineHandler);

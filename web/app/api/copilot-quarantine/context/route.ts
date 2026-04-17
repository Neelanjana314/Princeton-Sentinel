import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import { fetchCopilotQuarantineContext } from "@/app/lib/copilot-quarantine";

export const dynamic = "force-dynamic";

const getHandler = async function GET() {
  const { session } = await requireAdmin();

  try {
    const context = await fetchCopilotQuarantineContext(session);
    return NextResponse.json(context);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "copilot_quarantine_context_failed" },
      { status: 502 }
    );
  }
};

export const GET = withApiRequestTiming("/api/copilot-quarantine/context", getHandler);

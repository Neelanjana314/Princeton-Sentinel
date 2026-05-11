import { NextResponse } from "next/server";
import { getGroupsFromSession, getSession, isAdmin } from "@/app/lib/auth";
import { warmCopilotQuarantineAuth } from "@/app/lib/copilot-quarantine";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

const getHandler = async function GET() {
  const session = await getSession();
  const groups = getGroupsFromSession(session);

  if (!session) {
    return NextResponse.json({ warmed: false, reason: "no_session" }, { status: 200 });
  }

  if (!(await isAdmin(groups))) {
    return NextResponse.json({ warmed: false, reason: "not_admin" }, { status: 200 });
  }

  try {
    const result = await warmCopilotQuarantineAuth(session);
    return NextResponse.json({ warmed: true, ...result });
  } catch (error) {
    return NextResponse.json(
      {
        warmed: false,
        reason: error instanceof Error ? error.message : "auth_warmup_failed",
      },
      { status: 200 }
    );
  }
};

export const GET = withApiRequestTiming("/api/auth/warmup", getHandler);

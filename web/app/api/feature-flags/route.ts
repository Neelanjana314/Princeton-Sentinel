import { NextResponse } from "next/server";

import { requireUser } from "@/app/lib/auth";
import { getFeatureFlagsPayload } from "@/app/lib/feature-flags";
import { withApiRequestTiming } from "@/app/lib/request-timing";

export const dynamic = "force-dynamic";

const getHandler = async function GET() {
  await requireUser();
  const payload = await getFeatureFlagsPayload();
  return NextResponse.json(payload);
};

export const GET = withApiRequestTiming("/api/feature-flags", getHandler);

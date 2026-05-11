import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

function isValidHeartbeatToken(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export async function POST(req: Request) {
  const expectedToken = process.env.WORKER_HEARTBEAT_TOKEN;
  if (!expectedToken) {
    return NextResponse.json({ error: "WORKER_HEARTBEAT_TOKEN not set" }, { status: 500 });
  }
  const providedToken = req.headers.get("x-worker-heartbeat-token") || "";
  if (!providedToken || !isValidHeartbeatToken(providedToken, expectedToken)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      await req.json();
    } catch {
      // Ignore invalid payloads; endpoint is liveness-only.
    }
  }
  return NextResponse.json({ ok: true, received_at: new Date().toISOString() });
}

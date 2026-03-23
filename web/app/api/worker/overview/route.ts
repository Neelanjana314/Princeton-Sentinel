import { NextResponse } from "next/server";

import { getAdminJobControlState } from "@/app/admin/job-control";
import { requireAdmin } from "@/app/lib/auth";
import { withApiRequestTiming } from "@/app/lib/request-timing";
import { callWorker, isWorkerTimeoutError, parseWorkerErrorText } from "@/app/lib/worker-api";

export const dynamic = "force-dynamic";

async function parseWorkerJson(resBody: string) {
  try {
    return resBody ? JSON.parse(resBody) : {};
  } catch {
    return null;
  }
}

type SafeWorkerFetchResult = {
  ok: boolean;
  status?: number;
  payload?: any;
  error?: string;
};

async function safeWorkerFetch(path: string): Promise<SafeWorkerFetchResult> {
  try {
    const { res, text } = await callWorker(path);
    const parsed = await parseWorkerJson(text);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: parseWorkerErrorText(text),
      };
    }
    if (parsed === null) {
      return { ok: false, status: 502, error: "worker_invalid_json_response" };
    }
    return { ok: true, status: res.status, payload: parsed };
  } catch (err: unknown) {
    if (isWorkerTimeoutError(err)) {
      return { ok: false, status: 504, error: "worker_request_timeout" };
    }
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : "worker_unreachable",
    };
  }
}

const getHandler = async function GET() {
  await requireAdmin();
  const [healthRes, jobsRes, adminJobControl] = await Promise.all([
    safeWorkerFetch("/health"),
    safeWorkerFetch("/jobs/status"),
    getAdminJobControlState(),
  ]);

  const healthPayload = healthRes.ok ? healthRes.payload || {} : null;
  const jobsPayload = jobsRes.ok ? jobsRes.payload || {} : null;
  const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];

  if (!healthRes.ok || !jobsRes.ok) {
    return NextResponse.json(
      {
        error: "worker_overview_failed",
        health_error: healthRes.ok ? null : healthRes.error || `HTTP ${healthRes.status || 502}`,
        jobs_error: jobsRes.ok ? null : jobsRes.error || `HTTP ${jobsRes.status || 502}`,
        health: healthPayload || {},
        jobs,
        adminJobControl,
      },
      { status: Math.max(healthRes.status || 502, jobsRes.status || 502) }
    );
  }

  return NextResponse.json({
    health: healthPayload || {},
    jobs,
    adminJobControl,
  });
};

export const GET = withApiRequestTiming("/api/worker/overview", getHandler);

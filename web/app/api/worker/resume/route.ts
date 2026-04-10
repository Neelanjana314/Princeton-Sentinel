import { NextResponse } from "next/server";
import { requireAdmin } from "@/app/lib/auth";
import { validateCsrfRequest } from "@/app/lib/csrf";
import { LicenseFeatureError, requireLicenseFeature } from "@/app/lib/license";
import { callWorker, isWorkerTimeoutError, parseWorkerErrorText } from "@/app/lib/worker-api";
import { getNonEmptyString, parseRequestBody } from "@/app/lib/request-body";
import { withApiRequestTiming } from "@/app/lib/request-timing";
export const dynamic = "force-dynamic";

function redirectTarget(body: any, fallback: string) {
  const value = typeof body?.redirect_to === "string" ? body.redirect_to : "";
  if (value.startsWith("/admin")) return value;
  return fallback;
}

function redirectWithError(target: string, error: string, status?: number) {
  const url = new URL(target, "http://localhost");
  url.searchParams.set("error", error.slice(0, 200));
  if (status) {
    url.searchParams.set("status", String(status));
  }
  return new NextResponse(null, { status: 303, headers: { Location: `${url.pathname}${url.search}` } });
}

function errorResponse(bodyType: "json" | "form" | "none", target: string, error: string, status: number) {
  if (bodyType === "form") {
    return redirectWithError(target, error, status);
  }
  return NextResponse.json({ error }, { status });
}

const postHandler = async function POST(req: Request) {
  const { session } = await requireAdmin();
  const parsed = await parseRequestBody(req);
  const body = parsed.body;
  const target = redirectTarget(body, "/admin");

  if (parsed.invalidJson) {
    return errorResponse(parsed.bodyType, target, "invalid_json_body", 400);
  }
  const csrfValidation = validateCsrfRequest(req, body);
  const csrfError = "error" in csrfValidation ? csrfValidation.error : null;
  if (csrfError) {
    return errorResponse(parsed.bodyType, target, csrfError, 403);
  }

  const jobId = getNonEmptyString(body.job_id);
  if (!jobId) {
    return errorResponse(parsed.bodyType, target, "job_id_required", 400);
  }

  try {
    await requireLicenseFeature("job_control");
  } catch (err: unknown) {
    if (err instanceof LicenseFeatureError) {
      return errorResponse(parsed.bodyType, target, err.message, 403);
    }
    throw err;
  }

  try {
    const { res, text } = await callWorker("/jobs/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        actor: {
          oid: (session.user as any)?.oid,
          upn: (session.user as any)?.upn,
          name: session.user?.name,
        },
      }),
    });

    if (!res.ok) {
      const error = parseWorkerErrorText(text);
      return errorResponse(parsed.bodyType, target, error, res.status);
    }
  } catch (err: unknown) {
    if (isWorkerTimeoutError(err)) {
      return errorResponse(parsed.bodyType, target, "worker_request_timeout", 504);
    }
    const message = err instanceof Error ? err.message : "worker_request_failed";
    return errorResponse(parsed.bodyType, target, message, 502);
  }

  if (parsed.bodyType === "form") {
    return new NextResponse(null, { status: 303, headers: { Location: target } });
  }

  return NextResponse.json({ status: "resumed" }, { status: 200 });
};

export const POST = withApiRequestTiming("/api/worker/resume", postHandler);

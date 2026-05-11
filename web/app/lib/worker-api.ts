import { fetchWithTimeout, getPositiveIntEnv, HttpTimeoutError } from "@/app/lib/http";
import { getPositiveIntRuntimeEnv, requireRuntimeEnv } from "@/app/lib/runtime-env";

const WORKER_INTERNAL_TOKEN_HEADER = "x-worker-internal-token";
type CallWorkerResult = { res: Response; text: string };
type CallWorkerOverride = (path: string, init?: RequestInit) => Promise<CallWorkerResult>;

let callWorkerOverride: CallWorkerOverride | null = null;

export class WorkerApiError extends Error {
  status: number;
  bodyText: string;

  constructor(status: number, bodyText: string) {
    super(`worker_api_error_${status}`);
    this.name = "WorkerApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

function normalizeBaseUrl(base: string): string {
  return base.replace(/\/+$/, "");
}

async function buildWorkerUrl(path: string): Promise<string> {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;

  const base = await requireRuntimeEnv("WORKER_API_URL");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizeBaseUrl(base)}${trimmedPath}`;
}

async function getInternalToken(): Promise<string> {
  return requireRuntimeEnv("WORKER_INTERNAL_API_TOKEN");
}

export function isWorkerTimeoutError(err: unknown): boolean {
  return err instanceof HttpTimeoutError;
}

export async function callWorker(path: string, init: RequestInit = {}): Promise<CallWorkerResult> {
  if (callWorkerOverride) {
    return callWorkerOverride(path, init);
  }
  const url = await buildWorkerUrl(path);
  const token = await getInternalToken();
  const timeoutMs = await getPositiveIntRuntimeEnv("WORKER_API_TIMEOUT_MS", getPositiveIntEnv("WORKER_API_TIMEOUT_MS", 10000));

  const headers = new Headers(init.headers || {});
  headers.set(WORKER_INTERNAL_TOKEN_HEADER, token);

  const res = await fetchWithTimeout(url, { ...init, headers, cache: "no-store" }, timeoutMs);
  const text = await res.text();
  return { res, text };
}

export function setCallWorkerForTests(override: CallWorkerOverride | null) {
  callWorkerOverride = override;
}

export function parseWorkerErrorText(rawText: string): string {
  const text = (rawText || "").trim();
  if (!text) return "worker_request_failed";

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.error === "string" && parsed.error.trim()) return parsed.error.trim();
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    }
  } catch {
    // Not JSON, fall back to plain text below.
  }

  return text.slice(0, 300);
}

export async function callWorkerJson(path: string, init: RequestInit = {}): Promise<any> {
  const { res, text } = await callWorker(path, init);
  if (!res.ok) {
    throw new WorkerApiError(res.status, text);
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("worker_invalid_json_response");
  }
}

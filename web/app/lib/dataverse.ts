import "server-only";

import { ConfidentialClientApplication } from "@azure/msal-node";
import { fetchWithTimeout, HttpTimeoutError } from "@/app/lib/http";
import { requireRuntimeEnv } from "@/app/lib/runtime-env";

export type DataverseErrorType =
  | "not_configured"
  | "auth_failed"
  | "permission_denied"
  | "unreachable"
  | "unknown";

export class DataverseError extends Error {
  status: number;
  dvErrorType: DataverseErrorType;

  constructor(message: string, dvErrorType: DataverseErrorType, status = 502) {
    super(message);
    this.name = "DataverseError";
    this.status = status;
    this.dvErrorType = dvErrorType;
  }
}

type DataverseRow = Record<string, any>;

const DATAVERSE_FETCH_TIMEOUT_MS = 60_000;
const DATAVERSE_PATCH_TIMEOUT_MS = 30_000;
const DATAVERSE_CONNECT_TIMEOUT_MS = 10_000;
const DATAVERSE_TOKEN_TTL_FALLBACK_SECONDS = 55 * 60;

let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;
let tokenPromise: Promise<string> | null = null;
let msalClient: { cacheKey: string; client: ConfidentialClientApplication } | null = null;

async function getBaseUrl(): Promise<string> {
  const baseUrl = (await requireRuntimeEnv("DATAVERSE_BASE_URL")).trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new DataverseError("DATAVERSE_BASE_URL must be set", "not_configured");
  }
  return baseUrl;
}

async function getEntraConfig() {
  const tenantId = (await requireRuntimeEnv("ENTRA_TENANT_ID")).trim();
  const clientId = (await requireRuntimeEnv("ENTRA_CLIENT_ID")).trim();
  const clientSecret = (await requireRuntimeEnv("ENTRA_CLIENT_SECRET")).trim();

  if (!tenantId || !clientId || !clientSecret) {
    throw new DataverseError(
      "ENTRA_TENANT_ID/ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET must be set",
      "not_configured"
    );
  }

  return { tenantId, clientId, clientSecret };
}

async function getMsalClient(): Promise<ConfidentialClientApplication> {
  const { tenantId, clientId, clientSecret } = await getEntraConfig();
  const baseUrl = await getBaseUrl();
  const cacheKey = `${tenantId}:${clientId}:${clientSecret}:${baseUrl}`;
  if (msalClient?.cacheKey === cacheKey) return msalClient.client;

  cachedToken = null;
  cachedTokenExpiresAt = 0;
  tokenPromise = null;
  const client = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  });
  msalClient = { cacheKey, client };
  return client;
}

function classifyDataverseError(error: unknown): DataverseErrorType {
  if (error instanceof DataverseError) return error.dvErrorType;
  if (error instanceof HttpTimeoutError) return "unreachable";

  const message = error instanceof Error ? error.message : String(error || "");
  const normalized = message.toLowerCase();

  if (normalized.includes("dataverse_base_url must be set") || normalized.includes("entra_")) {
    return "not_configured";
  }
  if (
    normalized.includes("failed to acquire dataverse token") ||
    normalized.includes("(401)") ||
    normalized.includes("unauthorized")
  ) {
    return "auth_failed";
  }
  if (normalized.includes("(403)") || normalized.includes("forbidden")) {
    return "permission_denied";
  }
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("connectionerror") ||
    normalized.includes("failed to establish") ||
    normalized.includes("fetch failed") ||
    normalized.includes("(503)")
  ) {
    return "unreachable";
  }
  return "unknown";
}

function toDataverseError(error: unknown, fallbackMessage: string): DataverseError {
  if (error instanceof DataverseError) return error;
  const message = error instanceof Error ? error.message : fallbackMessage;
  return new DataverseError(message, classifyDataverseError(error));
}

async function acquireTokenInternal(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const client = await getMsalClient();
  const scope = `${await getBaseUrl()}/.default`;
  const result = await client.acquireTokenByClientCredential({ scopes: [scope] });

  const accessToken = result?.accessToken;
  if (!accessToken) {
    throw new DataverseError("Failed to acquire Dataverse token", "auth_failed");
  }

  const expiresIn = typeof result.expiresOn === "number"
    ? Math.max(0, result.expiresOn - Math.floor(Date.now() / 1000))
    : result?.expiresOn instanceof Date
      ? Math.max(0, Math.floor((result.expiresOn.getTime() - Date.now()) / 1000))
      : DATAVERSE_TOKEN_TTL_FALLBACK_SECONDS;

  cachedToken = accessToken;
  cachedTokenExpiresAt = Date.now() + expiresIn * 1000;
  return accessToken;
}

export async function getDataverseToken(): Promise<string> {
  if (!tokenPromise) {
    tokenPromise = acquireTokenInternal().finally(() => {
      tokenPromise = null;
    });
  }
  return tokenPromise;
}

async function fetchDataverse(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const token = await getDataverseToken();
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);

  return fetchWithTimeout(
    url,
    {
      ...init,
      headers,
    },
    DATAVERSE_CONNECT_TIMEOUT_MS + timeoutMs
  );
}

async function buildODataUrl(entitySet: string, select?: string | null, filter?: string | null, top?: number | null): Promise<string> {
  const url = new URL(`${await getBaseUrl()}/api/data/v9.2/${entitySet}`);
  if (select) url.searchParams.set("$select", select);
  if (filter) url.searchParams.set("$filter", filter);
  if (top) url.searchParams.set("$top", String(top));
  return url.toString();
}

export async function fetchDataverseTable(
  entitySet: string,
  options: { select?: string | null; filter?: string | null; top?: number | null } = {}
): Promise<DataverseRow[]> {
  const headers = {
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    "Accept": "application/json",
    "Prefer": "odata.include-annotations=*",
  };

  const allRows: DataverseRow[] = [];
  let nextUrl: string | null = await buildODataUrl(entitySet, options.select, options.filter, options.top);

  while (nextUrl) {
    let response: Response;
    try {
      response = await fetchDataverse(nextUrl, { method: "GET", headers, cache: "no-store" }, DATAVERSE_FETCH_TIMEOUT_MS);
    } catch (error) {
      throw toDataverseError(error, "Dataverse request failed");
    }

    if (!response.ok) {
      const text = ((await response.text()) || "request_failed").slice(0, 400);
      throw new DataverseError(
        `Dataverse request failed (${response.status}): ${text}`,
        classifyDataverseError(`(${response.status}): ${text}`)
      );
    }

    const data = await response.json();
    allRows.push(...(Array.isArray(data?.value) ? data.value : []));
    nextUrl = typeof data?.["@odata.nextLink"] === "string" ? data["@odata.nextLink"] : null;
  }

  return allRows;
}

export async function patchDataverseRow(
  entitySet: string,
  rowId: string,
  data: Record<string, unknown>
): Promise<void> {
  const headers = {
    "OData-MaxVersion": "4.0",
    "OData-Version": "4.0",
    "Content-Type": "application/json",
    "If-Match": "*",
  };
  const url = `${await getBaseUrl()}/api/data/v9.2/${entitySet}(${rowId})`;

  let response: Response;
  try {
    response = await fetchDataverse(
      url,
      { method: "PATCH", headers, body: JSON.stringify(data), cache: "no-store" },
      DATAVERSE_PATCH_TIMEOUT_MS
    );
  } catch (error) {
    throw toDataverseError(error, "Dataverse PATCH failed");
  }

  if (!response.ok) {
    const text = ((await response.text()) || "request_failed").slice(0, 400);
    throw new DataverseError(
      `Dataverse PATCH failed (${response.status}): ${text}`,
      classifyDataverseError(`(${response.status}): ${text}`)
    );
  }
}

export function getDataverseErrorResponse(error: unknown, fallbackMessage: string) {
  const dvError = toDataverseError(error, fallbackMessage);
  return {
    error: dvError.message || fallbackMessage,
    dv_error_type: dvError.dvErrorType,
    status: dvError.status || 502,
  };
}

export function resetDataverseClientForTests() {
  cachedToken = null;
  cachedTokenExpiresAt = 0;
  tokenPromise = null;
  msalClient = null;
}

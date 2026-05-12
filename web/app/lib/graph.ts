import { ConfidentialClientApplication } from "@azure/msal-node";
import { fetchWithTimeout, getPositiveIntEnv, HttpTimeoutError } from "@/app/lib/http";
import { getPositiveIntRuntimeEnv, requireRuntimeEnv } from "@/app/lib/runtime-env";

const graphBase = "https://graph.microsoft.com/v1.0";
let cachedCca: { cacheKey: string; client: ConfidentialClientApplication } | null = null;

async function getGraphEnv() {
  const tenantId = await requireRuntimeEnv("ENTRA_TENANT_ID");
  const clientId = await requireRuntimeEnv("ENTRA_CLIENT_ID");
  const clientSecret = await requireRuntimeEnv("ENTRA_CLIENT_SECRET");
  return { tenantId, clientId, clientSecret };
}

async function getCca() {
  const { tenantId, clientId, clientSecret } = await getGraphEnv();
  const cacheKey = `${tenantId}:${clientId}:${clientSecret}`;
  if (cachedCca?.cacheKey === cacheKey) return cachedCca.client;
  const client = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  });
  cachedCca = { cacheKey, client };
  return client;
}

async function getAppToken() {
  const result = await (await getCca()).acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) {
    throw new Error("Failed to acquire Graph token");
  }
  return result.accessToken;
}

export async function graphGet(path: string) {
  const token = await getAppToken();
  const timeoutMs = await getPositiveIntRuntimeEnv("GRAPH_FETCH_TIMEOUT_MS", getPositiveIntEnv("GRAPH_FETCH_TIMEOUT_MS", 15000));
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${graphBase}${path}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
      timeoutMs
    );
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      throw new Error("graph_request_timeout");
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function graphDelete(path: string) {
  const token = await getAppToken();
  const timeoutMs = await getPositiveIntRuntimeEnv("GRAPH_FETCH_TIMEOUT_MS", getPositiveIntEnv("GRAPH_FETCH_TIMEOUT_MS", 15000));
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${graphBase}${path}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        cache: "no-store",
      },
      timeoutMs
    );
  } catch (err) {
    if (err instanceof HttpTimeoutError) {
      throw new Error("graph_request_timeout");
    }
    throw err;
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph error ${res.status}: ${text}`);
  }
}

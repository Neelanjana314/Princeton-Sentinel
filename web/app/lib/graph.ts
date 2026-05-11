import { ConfidentialClientApplication } from "@azure/msal-node";
import { fetchWithTimeout, getPositiveIntEnv, HttpTimeoutError } from "@/app/lib/http";

const graphBase = "https://graph.microsoft.com/v1.0";
let cachedCca: ConfidentialClientApplication | null = null;
const GRAPH_FETCH_TIMEOUT_MS = getPositiveIntEnv("GRAPH_FETCH_TIMEOUT_MS", 15000);

function getGraphEnv() {
  const tenantId = process.env.ENTRA_TENANT_ID;
  const clientId = process.env.ENTRA_CLIENT_ID;
  const clientSecret = process.env.ENTRA_CLIENT_SECRET;
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("ENTRA_TENANT_ID/ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET must be set");
  }
  return { tenantId, clientId, clientSecret };
}

function getCca() {
  if (cachedCca) return cachedCca;
  const { tenantId, clientId, clientSecret } = getGraphEnv();
  cachedCca = new ConfidentialClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
      clientSecret,
    },
  });
  return cachedCca;
}

async function getAppToken() {
  const result = await getCca().acquireTokenByClientCredential({
    scopes: ["https://graph.microsoft.com/.default"],
  });
  if (!result?.accessToken) {
    throw new Error("Failed to acquire Graph token");
  }
  return result.accessToken;
}

export async function graphGet(path: string) {
  const token = await getAppToken();
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
      GRAPH_FETCH_TIMEOUT_MS
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
      GRAPH_FETCH_TIMEOUT_MS
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

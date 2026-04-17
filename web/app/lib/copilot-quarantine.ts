import { fetchWithTimeout, HttpTimeoutError, getPositiveIntEnv } from "@/app/lib/http";
import { fetchDataverseTable } from "@/app/lib/dataverse";
import { getDelegatedAuthState, saveDelegatedAuthState } from "@/app/lib/delegated-auth-store";
import type { Session } from "next-auth";

const GRAPH_SCOPE = "https://graph.microsoft.com/Directory.Read.All";
const POWER_PLATFORM_SCOPE = "https://api.powerplatform.com/CopilotStudio.AdminActions.Invoke";
const POWER_PLATFORM_API_SCOPE = POWER_PLATFORM_SCOPE;
const GRAPH_TOKEN_TIMEOUT_MS = getPositiveIntEnv("GRAPH_FETCH_TIMEOUT_MS", 15000);
const POWER_PLATFORM_TIMEOUT_MS = getPositiveIntEnv("POWER_PLATFORM_FETCH_TIMEOUT_MS", 20000);
const ROLE_CACHE_TTL_MS = getPositiveIntEnv("COPILOT_ROLE_CACHE_TTL_SECONDS", 900) * 1000;
const ENVIRONMENT_CACHE_TTL_MS = 15 * 60 * 1000;

const ALLOWED_ROLE_DISPLAY_NAMES = new Set([
  "global administrator",
  "ai administrator",
  "power platform administrator",
]);

type CachedRoleCheck = RoleCheckResult & {
  cacheKey: string;
  cachedAtMs: number;
  authStateUpdatedAt: number | null;
};

type CachedDelegatedToken = PowerPlatformTokenResult & {
  cacheKey: string;
  cachedAtMs: number;
  authStateUpdatedAt: number | null;
  expiresAtMs: number | null;
};

type CachedEnvironment = {
  dataverseBaseUrl: string;
  environmentId: string;
  cachedAtMs: number;
};

type PowerPlatformTokenResult = {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  needsConsent: boolean;
};

type PowerPlatformRequestError = Error & {
  status?: number;
  path?: string;
  method?: "GET" | "POST";
  environmentId?: string;
  botId?: string;
  botName?: string;
};

export type RoleCheckResult = {
  allowed: boolean;
  matchedRoles: string[];
  roleNames: string[];
  checkedAt: string;
  error: string | null;
};

export type CopilotQuarantineAgentRow = {
  botId: string;
  botName: string;
  lastUpdateTimeUtc: string | null;
  isQuarantined: boolean | null;
  state: string;
  actionLabel: "Block" | "Unblock";
  error: string | null;
};

let roleCache = new Map<string, CachedRoleCheck>();
let environmentCache = new Map<string, CachedEnvironment>();
let delegatedTokenCache = new Map<string, CachedDelegatedToken>();

function getEntraConfig() {
  const tenantId = process.env.ENTRA_TENANT_ID?.trim() || "";
  const clientId = process.env.ENTRA_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.ENTRA_CLIENT_SECRET?.trim() || "";
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error("ENTRA_TENANT_ID/ENTRA_CLIENT_ID/ENTRA_CLIENT_SECRET must be set");
  }
  return { tenantId, clientId, clientSecret };
}

function getDataverseBaseUrl() {
  const baseUrl = process.env.DATAVERSE_BASE_URL?.trim().replace(/\/+$/, "") || "";
  if (!baseUrl) {
    throw new Error("DATAVERSE_BASE_URL must be set");
  }
  return baseUrl;
}

function getConfiguredPowerPlatformEnvironmentId() {
  return process.env.POWER_PLATFORM_ENVIRONMENT_ID?.trim() || "";
}

function getMappingTableUrl() {
  const tableUrl = process.env.DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL?.trim() || "";
  if (!tableUrl) {
    throw new Error("DATAVERSE_AGENT_SECURITY_GROUP_MAPPING_TABLE_URL must be set");
  }
  return tableUrl;
}

function getEntitySetFromUrl(tableUrl: string) {
  return tableUrl.split("/").pop() || "";
}

function normalize(value: string | null | undefined) {
  return (value || "").trim().toLowerCase();
}

function normalizeDataverseUrl(value: string | null | undefined) {
  return (value || "").trim().replace(/\/+$/, "").toLowerCase();
}

function getSessionIdentity(session: Session | any) {
  return {
    oid: ((session?.user as any)?.oid as string | null | undefined) || null,
    upn:
      ((session?.user as any)?.upn as string | null | undefined) ||
      (typeof session?.user?.email === "string" ? session.user.email : null),
  };
}

function parseJwtPayload(token: string | null | undefined): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function getTokenScopes(accessToken: string | null | undefined): string[] {
  const payload = parseJwtPayload(accessToken);
  const scope = typeof payload?.scp === "string" ? payload.scp : "";
  return scope
    .split(" ")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getTokenExpiresAt(accessToken: string | null | undefined): number | null {
  const payload = parseJwtPayload(accessToken);
  return typeof payload?.exp === "number" ? payload.exp * 1000 : null;
}

function normalizeScopes(scopes: string[]) {
  return scopes
    .map((value) => value.trim())
    .filter(Boolean)
    .sort()
    .join(" ");
}

function buildDelegatedTokenCacheKey(session: Session | any, scopes: string[]) {
  const identity = getSessionIdentity(session);
  const baseKey = getDelegatedAuthState(identity.oid, identity.upn)?.key;
  if (!baseKey) {
    return null;
  }
  return `${baseKey}|scopes:${normalizeScopes(scopes)}`;
}

function readDelegatedTokenCache(session: Session | any, scopes: string[]): CachedDelegatedToken | null {
  const cacheKey = buildDelegatedTokenCacheKey(session, scopes);
  if (!cacheKey) {
    return null;
  }

  const cached = delegatedTokenCache.get(cacheKey);
  if (!cached) {
    return null;
  }

  if (cached.authStateUpdatedAt !== getAuthStateUpdatedAt(session)) {
    delegatedTokenCache.delete(cacheKey);
    return null;
  }

  if (cached.expiresAtMs && cached.expiresAtMs - Date.now() <= 60_000) {
    delegatedTokenCache.delete(cacheKey);
    return null;
  }

  if (!cached.accessToken && Date.now() - cached.cachedAtMs > 5 * 60 * 1000) {
    delegatedTokenCache.delete(cacheKey);
    return null;
  }

  return cached;
}

function writeDelegatedTokenCache(
  session: Session | any,
  scopes: string[],
  result: PowerPlatformTokenResult,
  expiresAtMs?: number | null
) {
  const cacheKey = buildDelegatedTokenCacheKey(session, scopes);
  if (!cacheKey) {
    return;
  }

  delegatedTokenCache.set(cacheKey, {
    ...result,
    cacheKey,
    cachedAtMs: Date.now(),
    authStateUpdatedAt: getAuthStateUpdatedAt(session),
    expiresAtMs: expiresAtMs ?? getTokenExpiresAt(result.accessToken),
  });
}

async function refreshAccessToken(refreshToken: string, scopes: string[]): Promise<PowerPlatformTokenResult> {
  const { tenantId, clientId, clientSecret } = getEntraConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    scope: scopes.join(" "),
  });

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        cache: "no-store",
      },
      POWER_PLATFORM_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      throw new Error("entra_token_request_timeout");
    }
    throw error;
  }

  const rawText = await response.text();
  let payload: Record<string, any> = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const description =
      typeof payload?.error_description === "string"
        ? payload.error_description
        : typeof payload?.error === "string"
          ? payload.error
          : `entra_token_refresh_failed_${response.status}`;
    if (/consent|required|interaction_required|invalid_grant/i.test(description)) {
      return { accessToken: "", refreshToken: null, scopes: [], needsConsent: true };
    }
    throw new Error(description);
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  const nextRefreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : null;
  if (!accessToken) {
    throw new Error("entra_token_missing_access_token");
  }

  return {
    accessToken,
    refreshToken: nextRefreshToken,
    scopes: getTokenScopes(accessToken),
    needsConsent: false,
  };
}

async function getDelegatedAccessToken(session: Session | any, scopes: string[]): Promise<PowerPlatformTokenResult> {
  const cached = readDelegatedTokenCache(session, scopes);
  if (cached) {
    return {
      accessToken: cached.accessToken,
      refreshToken: cached.refreshToken,
      scopes: cached.scopes,
      needsConsent: cached.needsConsent,
    };
  }

  const identity = getSessionIdentity(session);
  const state = getDelegatedAuthState(identity.oid, identity.upn);
  if (!state?.refreshToken) {
    const result = { accessToken: "", refreshToken: null, scopes: [], needsConsent: true };
    writeDelegatedTokenCache(session, scopes, result, null);
    return result;
  }

  const result = await refreshAccessToken(state.refreshToken, scopes);
  if (!result.needsConsent) {
    const payload = parseJwtPayload(result.accessToken);
    const expiresAt =
      typeof payload?.exp === "number" ? payload.exp * 1000 : Date.now() + 60 * 60 * 1000;
    saveDelegatedAuthState({
      oid: identity.oid,
      upn: identity.upn,
      accessToken: result.accessToken,
      accessTokenExpiresAt: expiresAt,
      refreshToken: result.refreshToken ?? state.refreshToken,
      scope: result.scopes.join(" "),
    });
    writeDelegatedTokenCache(session, scopes, result, expiresAt);
  } else {
    writeDelegatedTokenCache(session, scopes, result, null);
  }
  return result;
}

async function graphGet(accessToken: string, path: string) {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://graph.microsoft.com/v1.0${path}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        cache: "no-store",
      },
      GRAPH_TOKEN_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      throw new Error("graph_request_timeout");
    }
    throw error;
  }

  if (!response.ok) {
    const text = ((await response.text()) || "").slice(0, 400);
    throw new Error(text ? `graph_error_${response.status}:${text}` : `graph_error_${response.status}`);
  }
  return response.json();
}

async function powerPlatformRequest(
  accessToken: string,
  method: "GET" | "POST",
  path: string,
) {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `https://api.powerplatform.com${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        cache: "no-store",
      },
      POWER_PLATFORM_TIMEOUT_MS
    );
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      throw new Error("power_platform_request_timeout");
    }
    throw error;
  }

  const text = await response.text();
  let payload: Record<string, any> | null = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      (typeof payload?.error?.message === "string" && payload.error.message) ||
      (typeof payload?.message === "string" && payload.message) ||
      text ||
      `power_platform_error_${response.status}`;
    const error = new Error(message.slice(0, 500)) as PowerPlatformRequestError;
    error.status = response.status;
    error.path = path;
    error.method = method;
    throw error;
  }

  return payload ?? {};
}

function buildRoleCacheKey(session: Session | any) {
  const identity = getSessionIdentity(session);
  return normalize(identity.oid) || normalize(identity.upn) || "unknown";
}

function getAuthStateUpdatedAt(session: Session | any) {
  const identity = getSessionIdentity(session);
  const state = getDelegatedAuthState(identity.oid, identity.upn);
  return typeof state?.updatedAt === "number" ? state.updatedAt : null;
}

function readRoleCache(session: Session | any): RoleCheckResult | null {
  const cacheKey = buildRoleCacheKey(session);
  const cached = roleCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAtMs > ROLE_CACHE_TTL_MS) {
    roleCache.delete(cacheKey);
    return null;
  }
  if (cached.authStateUpdatedAt !== getAuthStateUpdatedAt(session)) {
    roleCache.delete(cacheKey);
    return null;
  }
  return cached;
}

function writeRoleCache(session: Session | any, result: RoleCheckResult) {
  const cacheKey = buildRoleCacheKey(session);
  if (result.error && result.error !== "graph_consent_required" && result.error !== "graph_token_unavailable") {
    roleCache.delete(cacheKey);
    return;
  }
  roleCache.set(cacheKey, {
    ...result,
    cacheKey,
    cachedAtMs: Date.now(),
    authStateUpdatedAt: getAuthStateUpdatedAt(session),
  });
}

export async function evaluateCopilotQuarantineRoles(session: Session | any): Promise<RoleCheckResult> {
  const cached = readRoleCache(session);
  if (cached) {
    return cached;
  }

  try {
    const tokenResult = await getDelegatedAccessToken(session, [GRAPH_SCOPE]);
    if (!tokenResult.accessToken) {
      const result: RoleCheckResult = {
        allowed: false,
        matchedRoles: [],
        roleNames: [],
        checkedAt: new Date().toISOString(),
        error: tokenResult.needsConsent ? "graph_consent_required" : "graph_token_unavailable",
      };
      writeRoleCache(session, result);
      return result;
    }

    const payload = await graphGet(
      tokenResult.accessToken,
      "/me/transitiveMemberOf/microsoft.graph.directoryRole?$select=id,displayName,roleTemplateId"
    );
    const items = Array.isArray(payload?.value) ? payload.value : [];
    const roleNames = items
      .map((item) => (typeof item?.displayName === "string" ? item.displayName.trim() : ""))
      .filter(Boolean);
    const matchedRoles = roleNames.filter((name) => ALLOWED_ROLE_DISPLAY_NAMES.has(name.toLowerCase()));
    const result: RoleCheckResult = {
      allowed: matchedRoles.length > 0,
      matchedRoles,
      roleNames,
      checkedAt: new Date().toISOString(),
      error: null,
    };
    writeRoleCache(session, result);
    return result;
  } catch (error) {
    const result: RoleCheckResult = {
      allowed: false,
      matchedRoles: [],
      roleNames: [],
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "graph_role_check_failed",
    };
    writeRoleCache(session, result);
    return result;
  }
}

async function getPowerPlatformContext(session: Session | any) {
  const tokenResult = await getDelegatedAccessToken(session, [POWER_PLATFORM_API_SCOPE]);
  return {
    accessToken: tokenResult.accessToken,
    needsConsent: tokenResult.needsConsent,
    scopes: tokenResult.scopes,
    hasRequiredScope: tokenResult.scopes.includes("CopilotStudio.AdminActions.Invoke"),
  };
}

function findStringValue(row: Record<string, any>, preferredKeys: string[]) {
  for (const key of preferredKeys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  for (const [key, value] of Object.entries(row)) {
    if (preferredKeys.some((candidate) => key.toLowerCase().endsWith(candidate.toLowerCase())) && typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

async function fetchMappingRows() {
  const tableUrl = getMappingTableUrl();
  const entitySet = getEntitySetFromUrl(tableUrl);
  const rows = await fetchDataverseTable(entitySet);
  const seen = new Set<string>();
  return rows
    .map((row) => ({
      botId: findStringValue(row, ["BotID", "botid"]),
      botName: findStringValue(row, ["AgentName", "agentname"]),
    }))
    .filter((row) => row.botId && row.botName)
    .filter((row) => {
      const key = normalize(row.botId);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((row) => ({ botId: row.botId as string, botName: row.botName as string }))
    .sort((left, right) => left.botName.localeCompare(right.botName));
}

async function resolveEnvironmentId(accessToken: string) {
  const configuredEnvironmentId = getConfiguredPowerPlatformEnvironmentId();
  if (configuredEnvironmentId) {
    return configuredEnvironmentId;
  }

  const dataverseBaseUrl = normalizeDataverseUrl(getDataverseBaseUrl());
  const cached = environmentCache.get(dataverseBaseUrl);
  if (cached && Date.now() - cached.cachedAtMs <= ENVIRONMENT_CACHE_TTL_MS) {
    return cached.environmentId;
  }

  const payload = await powerPlatformRequest(
    accessToken,
    "GET",
    "/environmentmanagement/environments?api-version=2022-03-01-preview"
  );
  const items = Array.isArray(payload?.value) ? payload.value : [];
  const match = items.find((item) => {
    const instanceUrl = normalizeDataverseUrl(item?.properties?.linkedEnvironmentMetadata?.instanceUrl);
    const instanceApiUrl = normalizeDataverseUrl(item?.properties?.linkedEnvironmentMetadata?.instanceApiUrl);
    return instanceUrl === dataverseBaseUrl || instanceApiUrl === dataverseBaseUrl;
  });

  const environmentId =
    typeof match?.id === "string" && match.id.trim()
      ? match.id.trim()
      : typeof match?.name === "string" && match.name.trim()
        ? match.name.trim()
        : typeof match?.properties?.linkedEnvironmentMetadata?.resourceId === "string" && match.properties.linkedEnvironmentMetadata.resourceId.trim()
          ? match.properties.linkedEnvironmentMetadata.resourceId.trim()
          : "";

  if (!environmentId) {
    throw new Error("power_platform_environment_not_found");
  }

  environmentCache.set(dataverseBaseUrl, {
    dataverseBaseUrl,
    environmentId,
    cachedAtMs: Date.now(),
  });
  return environmentId;
}

function mapStatusPayload(botId: string, botName: string, payload: Record<string, any>): CopilotQuarantineAgentRow {
  const isQuarantined =
    typeof payload?.isBotQuarantined === "boolean"
      ? payload.isBotQuarantined
      : typeof payload?.properties?.isBotQuarantined === "boolean"
        ? payload.properties.isBotQuarantined
        : null;
  const lastUpdateTimeUtc =
    typeof payload?.lastUpdateTimeUtc === "string"
      ? payload.lastUpdateTimeUtc
      : typeof payload?.properties?.lastUpdateTimeUtc === "string"
        ? payload.properties.lastUpdateTimeUtc
        : null;

  return {
    botId,
    botName,
    lastUpdateTimeUtc,
    isQuarantined,
    state:
      isQuarantined === true
        ? "Blocked"
        : isQuarantined === false
          ? "Active"
          : "Unknown",
    actionLabel: isQuarantined === true ? "Unblock" : "Block",
    error: null,
  };
}

function buildCopilotQuarantineStatusPath(environmentId: string, botId: string) {
  return `/copilotstudio/environments/${encodeURIComponent(environmentId)}/bots/${encodeURIComponent(botId)}/api/botQuarantine?api-version=1`;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export async function fetchCopilotQuarantineStatus(
  accessToken: string,
  botId: string,
  botName: string,
  environmentIdInput?: string,
): Promise<CopilotQuarantineAgentRow> {
  const environmentId = environmentIdInput || await resolveEnvironmentId(accessToken);
  const path = buildCopilotQuarantineStatusPath(environmentId, botId);
  try {
    const payload = await powerPlatformRequest(
      accessToken,
      "GET",
      path
    );
    return mapStatusPayload(botId, botName, payload);
  } catch (error) {
    if (error instanceof Error) {
      const requestError = error as PowerPlatformRequestError;
      requestError.environmentId = environmentId;
      requestError.botId = botId;
      requestError.botName = botName;
      requestError.path = requestError.path || path;
      requestError.method = requestError.method || "GET";
    }
    throw error;
  }
}

export async function fetchCopilotQuarantineContext(session: Session | any) {
  const roleCheck = await evaluateCopilotQuarantineRoles(session);
  if (!roleCheck.allowed) {
    const needsConsent = roleCheck.error === "graph_consent_required";
    return {
      canView: needsConsent,
      canAct: false,
      needsConsent,
      hasRequiredScope: false,
      roleCheck,
      agents: [],
    };
  }

  const powerPlatform = await getPowerPlatformContext(session);
  const mappingRows = await fetchMappingRows();

  let agents: CopilotQuarantineAgentRow[] = mappingRows.map((row) => ({
    botId: row.botId,
    botName: row.botName,
    lastUpdateTimeUtc: null,
    isQuarantined: null,
    state: "Unavailable",
    actionLabel: "Block",
    error: roleCheck.allowed ? "power_platform_token_unavailable" : null,
  }));

  if (roleCheck.allowed && powerPlatform.accessToken && powerPlatform.hasRequiredScope) {
    try {
      const environmentId = await resolveEnvironmentId(powerPlatform.accessToken);
      agents = await Promise.all(
        mappingRows.map(async (row) => {
          try {
            return await fetchCopilotQuarantineStatus(powerPlatform.accessToken, row.botId, row.botName, environmentId);
          } catch (error) {
            return {
              botId: row.botId,
              botName: row.botName,
              lastUpdateTimeUtc: null,
              isQuarantined: null,
              state: "Unavailable",
              actionLabel: "Block" as const,
              error: getErrorMessage(error, "power_platform_status_failed"),
            };
          }
        })
      );
    } catch (error) {
      agents = mappingRows.map((row) => ({
        botId: row.botId,
        botName: row.botName,
        lastUpdateTimeUtc: null,
        isQuarantined: null,
        state: "Unavailable",
        actionLabel: "Block" as const,
        error: getErrorMessage(error, "power_platform_environment_not_found"),
      }));
    }
  }

  return {
    canView: true,
    canAct: powerPlatform.hasRequiredScope,
    needsConsent: powerPlatform.needsConsent,
    hasRequiredScope: powerPlatform.hasRequiredScope,
    roleCheck,
    agents,
  };
}

export async function warmCopilotQuarantineAuth(session: Session | any) {
  const roleCheck = await evaluateCopilotQuarantineRoles(session);
  if (!roleCheck.allowed) {
    return {
      isEligibleAdmin: false,
      canView: false,
      canAct: false,
      needsConsent: roleCheck.error === "graph_consent_required",
      hasRequiredScope: false,
      roleCheck,
    };
  }

  const powerPlatform = await getPowerPlatformContext(session);
  return {
    isEligibleAdmin: true,
    canView: true,
    canAct: powerPlatform.hasRequiredScope,
    needsConsent: powerPlatform.needsConsent,
    hasRequiredScope: powerPlatform.hasRequiredScope,
    roleCheck,
  };
}

export async function toggleCopilotQuarantine(
  session: Session | any,
  action: "quarantine" | "unquarantine",
  botId: string,
  botName: string,
) {
  const roleCheck = await evaluateCopilotQuarantineRoles(session);
  if (!roleCheck.allowed) {
    throw new Error(roleCheck.error || "copilot_quarantine_role_forbidden");
  }

  const powerPlatform = await getPowerPlatformContext(session);
  if (powerPlatform.needsConsent || !powerPlatform.accessToken) {
    throw new Error("power_platform_consent_required");
  }
  if (!powerPlatform.hasRequiredScope) {
    throw new Error("power_platform_scope_missing");
  }

  const environmentId = await resolveEnvironmentId(powerPlatform.accessToken);
  const operation =
    action === "quarantine"
      ? "SetAsQuarantined"
      : "SetAsUnquarantined";
  await powerPlatformRequest(
    powerPlatform.accessToken,
    "POST",
    `/copilotstudio/environments/${encodeURIComponent(environmentId)}/bots/${encodeURIComponent(botId)}/api/botQuarantine/${operation}?api-version=1`
  );

  return fetchCopilotQuarantineStatus(powerPlatform.accessToken, botId, botName);
}

export function resetCopilotQuarantineCachesForTests() {
  roleCache = new Map<string, CachedRoleCheck>();
  environmentCache = new Map<string, CachedEnvironment>();
  delegatedTokenCache = new Map<string, CachedDelegatedToken>();
}

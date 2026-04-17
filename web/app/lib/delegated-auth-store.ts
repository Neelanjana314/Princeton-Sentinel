type DelegatedAuthState = {
  key: string;
  oid: string | null;
  upn: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: number | null;
  refreshToken: string | null;
  scope: string | null;
  updatedAt: number;
};

const STATE_TTL_MS = 24 * 60 * 60 * 1000;

let delegatedAuthState = new Map<string, DelegatedAuthState>();

function now() {
  return Date.now();
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function buildKey(oid: string | null | undefined, upn: string | null | undefined): string | null {
  const normalizedOid = normalize(oid);
  const normalizedUpn = normalize(upn);
  if (normalizedOid) return `oid:${normalizedOid}`;
  if (normalizedUpn) return `upn:${normalizedUpn}`;
  return null;
}

function pruneExpiredStates() {
  const cutoff = now() - STATE_TTL_MS;
  for (const [key, value] of delegatedAuthState.entries()) {
    if (value.updatedAt < cutoff) {
      delegatedAuthState.delete(key);
    }
  }
}

export function getDelegatedAuthStoreKey(oid: string | null | undefined, upn: string | null | undefined): string | null {
  return buildKey(oid, upn);
}

export function saveDelegatedAuthState(input: {
  oid?: string | null;
  upn?: string | null;
  accessToken?: string | null;
  accessTokenExpiresAt?: number | null;
  refreshToken?: string | null;
  scope?: string | null;
}) {
  pruneExpiredStates();
  const key = buildKey(input.oid ?? null, input.upn ?? null);
  if (!key) {
    return null;
  }

  const current = delegatedAuthState.get(key);
  const next: DelegatedAuthState = {
    key,
    oid: normalize(input.oid ?? current?.oid ?? null),
    upn: normalize(input.upn ?? current?.upn ?? null),
    accessToken: input.accessToken ?? current?.accessToken ?? null,
    accessTokenExpiresAt: input.accessTokenExpiresAt ?? current?.accessTokenExpiresAt ?? null,
    refreshToken: input.refreshToken ?? current?.refreshToken ?? null,
    scope: input.scope ?? current?.scope ?? null,
    updatedAt: now(),
  };

  delegatedAuthState.set(key, next);
  return next;
}

export function getDelegatedAuthState(oid: string | null | undefined, upn: string | null | undefined) {
  pruneExpiredStates();
  const key = buildKey(oid, upn);
  if (!key) {
    return null;
  }
  return delegatedAuthState.get(key) || null;
}

export function clearDelegatedAuthState(oid: string | null | undefined, upn: string | null | undefined) {
  const key = buildKey(oid, upn);
  if (!key) {
    return false;
  }
  return delegatedAuthState.delete(key);
}

export function resetDelegatedAuthStateForTests() {
  delegatedAuthState = new Map<string, DelegatedAuthState>();
}

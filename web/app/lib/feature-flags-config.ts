export const FEATURE_FLAG_DEFAULTS = {
  agents_dashboard: true,
  test_mode: false,
} as const;

export type FeatureKey = keyof typeof FEATURE_FLAG_DEFAULTS;
export type FeatureFlags = Record<FeatureKey, boolean>;
export type FeatureFlagsPayload = {
  flags: FeatureFlags;
  version: string | null;
};

type FeatureFlagRow = {
  feature_key: string;
  enabled: boolean;
};

const FEATURE_ROUTE_PREFIXES: Record<FeatureKey, string[]> = {
  agents_dashboard: ["/dashboard/agents", "/api/agents"],
  test_mode: [],
};

export function getDefaultFeatureFlags(): FeatureFlags {
  return { ...FEATURE_FLAG_DEFAULTS };
}

export function mergeFeatureFlags(rows: FeatureFlagRow[]): FeatureFlags {
  const merged = getDefaultFeatureFlags();

  for (const row of rows) {
    if (row.feature_key in FEATURE_FLAG_DEFAULTS) {
      merged[row.feature_key as FeatureKey] = Boolean(row.enabled);
    }
  }

  return merged;
}

export function isFeatureEnabled(featureKey: FeatureKey, flags: FeatureFlags): boolean {
  return Boolean(flags[featureKey]);
}

export function matchesFeaturePath(featureKey: FeatureKey, pathname: string): boolean {
  const normalizedPath = pathname || "/";
  return FEATURE_ROUTE_PREFIXES[featureKey].some((prefix) => normalizedPath.startsWith(prefix));
}

import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

import {
  type FeatureFlagsPayload,
  type FeatureFlags,
  type FeatureKey,
  isFeatureEnabled,
  mergeFeatureFlags,
} from "./feature-flags-config";
import { getCurrentLicenseSummary } from "./license";

export {
  FEATURE_FLAG_DEFAULTS,
  getDefaultFeatureFlags,
  isFeatureEnabled,
  matchesFeaturePath,
  mergeFeatureFlags,
} from "./feature-flags-config";

type FeatureFlagVersionRow = {
  last_updated_at: string | Date | null;
};

const FEATURE_STATE_VERSION_TABLES = ["feature_flags", "active_license_artifact", "local_testing_state"] as const;

type QueryFn = <T = any>(text: string, params?: any[]) => Promise<T[]>;

let featureFlagsQueryOverride: QueryFn | null = null;

export function setFeatureFlagsQueryForTests(queryFn: QueryFn | null) {
  featureFlagsQueryOverride = queryFn;
}

function normalizeVersion(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return String(value);
}

export async function getFeatureFlags(): Promise<FeatureFlags> {
  const rows = await runFeatureFlagsQuery<{ feature_key: string; enabled: boolean }>(
    `
    SELECT feature_key, enabled
    FROM feature_flags
    `
  );

  const flags = mergeFeatureFlags(rows);
  const license = await getCurrentLicenseSummary();
  return {
    ...flags,
    agents_dashboard: flags.agents_dashboard && license.features.agents_dashboard,
  };
}

export async function getFeatureFlagVersion(): Promise<string | null> {
  const rows = await runFeatureFlagsQuery<FeatureFlagVersionRow>(
    `
    SELECT MAX(last_updated_at) AS last_updated_at
    FROM table_update_log
    WHERE table_name = ANY($1::text[])
    `
    ,
    [FEATURE_STATE_VERSION_TABLES]
  );

  return normalizeVersion(rows[0]?.last_updated_at);
}

export async function getFeatureFlagsPayload(): Promise<FeatureFlagsPayload> {
  const [flags, version] = await Promise.all([getFeatureFlags(), getFeatureFlagVersion()]);
  return { flags, version };
}

export async function isFeatureEnabledInDb(featureKey: FeatureKey): Promise<boolean> {
  const flags = await getFeatureFlags();
  return isFeatureEnabled(featureKey, flags);
}

export async function redirectIfFeatureDisabled(featureKey: FeatureKey, redirectTo = "/dashboard"): Promise<void> {
  const enabled = await isFeatureEnabledInDb(featureKey);
  if (!enabled) {
    redirect(redirectTo);
  }
}

export async function getFeatureDisabledApiResponse(featureKey: FeatureKey): Promise<NextResponse | null> {
  const enabled = await isFeatureEnabledInDb(featureKey);
  if (enabled) {
    return null;
  }
  return NextResponse.json({ error: "not_found" }, { status: 404 });
}

async function runFeatureFlagsQuery<T = any>(text: string, params?: any[]): Promise<T[]> {
  if (featureFlagsQueryOverride) {
    return featureFlagsQueryOverride<T>(text, params);
  }

  const db = await import("./db");
  return db.query<T>(text, params);
}

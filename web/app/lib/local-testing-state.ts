import type { PoolClient } from "pg";

import { isLocalDockerDeployment } from "./runtime";

type LocalTestingStateRow = {
  emulate_license_enabled: boolean;
  updated_at: string | Date | null;
};

export type LocalTestingState = {
  emulateLicenseEnabled: boolean;
  updatedAt: string | null;
};

export type LocalTestingMenuState = {
  visible: boolean;
  emulateLicenseEnabled: boolean;
};

type StateOverride = LocalTestingState | (() => Promise<LocalTestingState>);

let stateOverride: StateOverride | null = null;

function normalizeTimestamp(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }

  return parsed.toISOString();
}

async function runLocalTestingStateQuery<T = any>(text: string, params?: any[]): Promise<T[]> {
  const db = await import("./db");
  return db.query<T>(text, params);
}

async function runLocalTestingStateTransaction<T>(fn: (client: PoolClient) => Promise<T>) {
  const db = await import("./db");
  return db.withTransaction(fn);
}

export async function getLocalTestingState(): Promise<LocalTestingState> {
  if (stateOverride) {
    return typeof stateOverride === "function" ? stateOverride() : stateOverride;
  }

  const rows = await runLocalTestingStateQuery<LocalTestingStateRow>(
    `
    SELECT emulate_license_enabled, updated_at
    FROM local_testing_state
    WHERE state_key = 'default'
    LIMIT 1
    `
  );
  const row = rows[0];

  return {
    emulateLicenseEnabled: row ? Boolean(row.emulate_license_enabled) : true,
    updatedAt: normalizeTimestamp(row?.updated_at),
  };
}

export async function setEmulatedLicenseEnabled(enabled: boolean): Promise<void> {
  await runLocalTestingStateTransaction(async (client) => {
    await client.query(
      `
      INSERT INTO local_testing_state (state_key, emulate_license_enabled, updated_at)
      VALUES ('default', $1, now())
      ON CONFLICT (state_key)
      DO UPDATE SET emulate_license_enabled = EXCLUDED.emulate_license_enabled, updated_at = now()
      `,
      [enabled]
    );
  });
}

export async function getLocalTestingMenuState(): Promise<LocalTestingMenuState> {
  if (!isLocalDockerDeployment()) {
    return {
      visible: false,
      emulateLicenseEnabled: true,
    };
  }

  const state = await getLocalTestingState();
  return {
    visible: true,
    emulateLicenseEnabled: state.emulateLicenseEnabled,
  };
}

export function setLocalTestingStateForTests(override: StateOverride | null) {
  stateOverride = override;
}

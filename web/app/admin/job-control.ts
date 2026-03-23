import { getCurrentLicenseSummary, type EffectiveLicenseSummary } from "@/app/lib/license";

export type AdminJobControlState = {
  jobControlEnabled: boolean;
  reason: string | null;
  message: string;
};

export function deriveAdminJobControlState(summary: EffectiveLicenseSummary): AdminJobControlState {
  if (summary.features.job_control) {
    return {
      jobControlEnabled: true,
      reason: null,
      message: "Job controls are available.",
    };
  }

  if (summary.status === "expired") {
    return {
      jobControlEnabled: false,
      reason: "license_expired",
      message: "The current license is expired. Admin job controls are read-only until a valid license is activated.",
    };
  }

  if (summary.status === "missing") {
    return {
      jobControlEnabled: false,
      reason: "license_missing",
      message: "There is no active license. Admin job controls are read-only until a valid license is activated.",
    };
  }

  if (summary.status === "invalid") {
    return {
      jobControlEnabled: false,
      reason: summary.verificationError || "license_invalid",
      message: "The current license is invalid. Admin job controls are read-only until a valid license is activated.",
    };
  }

  return {
    jobControlEnabled: false,
    reason: "license_feature_job_control_disabled",
    message: "This license does not include job control. Admin job controls are read-only.",
  };
}

export async function getAdminJobControlState(): Promise<AdminJobControlState> {
  const summary = await getCurrentLicenseSummary();
  return deriveAdminJobControlState(summary);
}

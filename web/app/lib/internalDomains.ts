import { getRuntimeEnv } from "@/app/lib/runtime-env";

export async function getInternalDomainPatterns() {
  const raw = (await getRuntimeEnv("INTERNAL_EMAIL_DOMAINS")) || "";
  const domains = raw
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const patterns: string[] = [];
  for (const domain of domains) {
    patterns.push(domain);
    patterns.push(`%.${domain}`);
  }
  return patterns;
}

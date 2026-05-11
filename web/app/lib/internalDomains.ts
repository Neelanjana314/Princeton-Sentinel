export function getInternalDomainPatterns() {
  const raw = process.env.INTERNAL_EMAIL_DOMAINS || "";
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

export type SearchParams = Record<string, string | string[] | undefined>;

export function getParam(searchParams: SearchParams | undefined, key: string) {
  if (!searchParams) return null;
  const raw = searchParams[key];
  if (!raw) return null;
  return Array.isArray(raw) ? raw[0] : raw;
}

export function getNumberParam(
  searchParams: SearchParams | undefined,
  key: string,
  fallback: number,
  min?: number,
  max?: number
) {
  const raw = getParam(searchParams, key);
  const parsed = raw ? Number(raw) : NaN;
  let value = Number.isFinite(parsed) ? parsed : fallback;
  if (min !== undefined) value = Math.max(min, value);
  if (max !== undefined) value = Math.min(max, value);
  return value;
}

export function getSortDirection(searchParams: SearchParams | undefined, fallback: "asc" | "desc" = "desc") {
  const dir = (getParam(searchParams, "dir") || "").toLowerCase();
  if (dir === "asc" || dir === "desc") return dir;
  return fallback;
}

export function getWindowDays(searchParams: SearchParams | undefined, fallback: number) {
  const raw = (getParam(searchParams, "days") || "").toLowerCase();
  if (raw === "all") return null;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

export function getPagination(searchParams: SearchParams | undefined, defaults: { page: number; pageSize: number }) {
  const page = getNumberParam(searchParams, "page", defaults.page, 1, 10000);
  const pageSize = getNumberParam(searchParams, "pageSize", defaults.pageSize, 10, 200);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset };
}

export type PaginationParams = Record<string, string | number | undefined | null>;
export type PaginationMode = "desktop" | "compact";

export type PaginationToken =
  | { type: "page"; page: number }
  | { type: "ellipsis"; key: string };

export type PaginationModel = {
  totalPages: number;
  clampedPage: number;
  hasPrev: boolean;
  hasNext: boolean;
  summary: string;
  desktopTokens: PaginationToken[];
  compactTokens: PaginationToken[];
  showCompactJump: boolean;
  jumpOptions: number[];
  prevHref: string | null;
  nextHref: string | null;
  hrefForPage: (page: number) => string;
};

export const DESKTOP_FULL_THRESHOLD = 7;
export const COMPACT_FULL_THRESHOLD = 5;

export function buildHref(pathname: string, params: PaginationParams) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    const str = String(v);
    if (!str) continue;
    sp.set(k, str);
  }
  const qs = sp.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function getPageRange(start: number, end: number) {
  if (end < start) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export function getPaginationTokens(page: number, totalPages: number, mode: PaginationMode): PaginationToken[] {
  const clampedPage = Math.min(Math.max(page, 1), totalPages);

  if (mode === "compact") {
    if (totalPages <= COMPACT_FULL_THRESHOLD) {
      return getPageRange(1, totalPages).map((value) => ({ type: "page" as const, page: value }));
    }

    return getPageRange(Math.max(1, clampedPage - 1), Math.min(totalPages, clampedPage + 1)).map((value) => ({
      type: "page" as const,
      page: value,
    }));
  }

  if (totalPages <= DESKTOP_FULL_THRESHOLD) {
    return getPageRange(1, totalPages).map((value) => ({ type: "page" as const, page: value }));
  }

  const visiblePages = Array.from(new Set([1, totalPages, ...getPageRange(clampedPage - 2, clampedPage + 2)])).filter(
    (value) => value >= 1 && value <= totalPages
  );
  visiblePages.sort((left, right) => left - right);

  const tokens: PaginationToken[] = [];
  for (const value of visiblePages) {
    const previous = tokens[tokens.length - 1];
    if (previous?.type === "page" && value - previous.page > 1) {
      tokens.push({ type: "ellipsis", key: `${previous.page}-${value}` });
    }
    tokens.push({ type: "page", page: value });
  }

  return tokens;
}

export function buildPaginationModel({
  pathname,
  page,
  pageSize,
  totalItems,
  extraParams,
  pageParam = "page",
  pageSizeParam = "pageSize",
}: {
  pathname: string;
  page: number;
  pageSize: number;
  totalItems: number;
  extraParams: PaginationParams;
  pageParam?: string;
  pageSizeParam?: string;
}): PaginationModel {
  const totalPages = Math.max(Math.ceil(totalItems / pageSize), 1);
  const clampedPage = Math.min(Math.max(page, 1), totalPages);
  const hasPrev = clampedPage > 1;
  const hasNext = clampedPage < totalPages;
  const hrefForPage = (targetPage: number) =>
    buildHref(pathname, {
      ...extraParams,
      [pageParam]: targetPage,
      [pageSizeParam]: pageSize,
    });

  return {
    totalPages,
    clampedPage,
    hasPrev,
    hasNext,
    summary: `Page ${clampedPage.toLocaleString()} of ${totalPages.toLocaleString()} • ${totalItems.toLocaleString()} items`,
    desktopTokens: getPaginationTokens(clampedPage, totalPages, "desktop"),
    compactTokens: getPaginationTokens(clampedPage, totalPages, "compact"),
    showCompactJump: totalPages > COMPACT_FULL_THRESHOLD,
    jumpOptions: getPageRange(1, totalPages),
    prevHref: hasPrev ? hrefForPage(clampedPage - 1) : null,
    nextHref: hasNext ? hrefForPage(clampedPage + 1) : null,
    hrefForPage,
  };
}

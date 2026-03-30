"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  buildHref,
  buildPaginationModel,
  type PaginationParams,
  type PaginationToken,
} from "@/lib/pagination";
import { cn } from "@/lib/utils";

type PaginationControlsProps = {
  pathname: string;
  page: number;
  pageSize: number;
  totalItems: number;
  extraParams: PaginationParams;
  pageParam?: string;
  pageSizeParam?: string;
  compact?: boolean;
  onJumpPage?: (page: number) => void;
};

export function PaginationControls({
  pathname,
  page,
  pageSize,
  totalItems,
  extraParams,
  pageParam = "page",
  pageSizeParam = "pageSize",
  compact = false,
  onJumpPage,
}: PaginationControlsProps) {
  const model = React.useMemo(
    () =>
      buildPaginationModel({
        pathname,
        page,
        pageSize,
        totalItems,
        extraParams,
        pageParam,
        pageSizeParam,
      }),
    [extraParams, page, pageParam, pageSize, pageSizeParam, pathname, totalItems]
  );
  const desktopJumpId = React.useId();
  const mobileJumpId = React.useId();
  const showCompactJump = compact && model.showCompactJump;

  const renderPageButton = (targetPage: number, size: "default" | "sm" = "sm") =>
    targetPage === model.clampedPage ? (
      <Button key={targetPage} asChild variant="default" size={size} className="min-w-9 px-2">
        <span aria-current="page">{targetPage.toLocaleString()}</span>
      </Button>
    ) : (
      <Button key={targetPage} asChild variant="outline" size={size} className="min-w-9 px-2">
        <Link href={model.hrefForPage(targetPage)} aria-label={`Go to page ${targetPage.toLocaleString()}`}>
          {targetPage.toLocaleString()}
        </Link>
      </Button>
    );

  const renderToken = (token: PaginationToken, size: "default" | "sm" = "sm") =>
    token.type === "page" ? (
      renderPageButton(token.page, size)
    ) : (
      <span key={token.key} className="px-1 text-sm text-muted-foreground" aria-hidden="true">
        …
      </span>
    );

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card p-3">
      <div className="text-sm text-muted-foreground">{model.summary}</div>

      <div className="hidden flex-wrap items-center justify-between gap-3 sm:flex">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {model.hasPrev ? (
            <Button asChild variant="outline">
              <Link href={model.prevHref!}>Previous</Link>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              Previous
            </Button>
          )}

          <div className="flex max-w-full flex-wrap items-center gap-1">
            {model.desktopTokens.map((token) => renderToken(token))}
          </div>

          {model.hasNext ? (
            <Button asChild variant="outline">
              <Link href={model.nextHref!}>Next</Link>
            </Button>
          ) : (
            <Button variant="outline" disabled>
              Next
            </Button>
          )}
        </div>

        {model.showCompactJump ? (
          <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <label htmlFor={desktopJumpId}>Jump to page</label>
            <select
              id={desktopJumpId}
              aria-label="Jump to page"
              value={String(model.clampedPage)}
              onChange={(event) => onJumpPage?.(Number(event.target.value))}
              className={cn(
                "h-10 min-w-28 rounded-md border border-input bg-background px-3 text-sm text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              )}
            >
              {model.jumpOptions.map((value) => (
                <option key={value} value={String(value)}>
                  Page {value.toLocaleString()}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2 sm:hidden">
        <div className="flex items-center justify-between gap-2">
          {model.hasPrev ? (
            <Button asChild variant="outline" size="sm">
              <Link href={model.prevHref!}>Previous</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Previous
            </Button>
          )}

          <div className="flex min-w-0 flex-wrap items-center justify-center gap-1">
            {model.compactTokens.map((token) => renderToken(token, "sm"))}
          </div>

          {model.hasNext ? (
            <Button asChild variant="outline" size="sm">
              <Link href={model.nextHref!}>Next</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled>
              Next
            </Button>
          )}
        </div>

        {showCompactJump ? (
          <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <label htmlFor={mobileJumpId}>Jump to page</label>
            <select
              id={mobileJumpId}
              aria-label="Jump to page"
              value={String(model.clampedPage)}
              onChange={(event) => onJumpPage?.(Number(event.target.value))}
              className={cn(
                "h-9 min-w-24 rounded-md border border-input bg-background px-2 text-sm text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              )}
            >
              {model.jumpOptions.map((value) => (
                <option key={value} value={String(value)}>
                  Page {value.toLocaleString()}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Pagination({
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
}) {
  const router = useRouter();

  return (
    <PaginationControls
      pathname={pathname}
      page={page}
      pageSize={pageSize}
      totalItems={totalItems}
      extraParams={extraParams}
      pageParam={pageParam}
      pageSizeParam={pageSizeParam}
      compact
      onJumpPage={(targetPage) => {
        router.push(
          buildHref(pathname, {
            ...extraParams,
            [pageParam]: targetPage,
            [pageSizeParam]: pageSize,
          })
        );
      }}
    />
  );
}

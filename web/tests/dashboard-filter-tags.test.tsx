import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Module = require("node:module");
const testGlobals = globalThis as typeof globalThis & {
  __psTmpAliasRegistered?: boolean;
  __psDashboardFilterMocksRegistered?: boolean;
};

if (!testGlobals.__psTmpAliasRegistered) {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function patchedResolveFilename(request: string, parent: unknown, isMain: boolean, options: unknown) {
    if (request.startsWith("@/")) {
      const mapped = path.join(process.cwd(), ".tmp-tests", request.slice(2));
      return originalResolveFilename.call(this, mapped, parent, isMain, options);
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  testGlobals.__psTmpAliasRegistered = true;
}

if (!testGlobals.__psDashboardFilterMocksRegistered) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "next/navigation") {
      return {
        usePathname: () => "/dashboard/activity",
        useRouter: () => ({ push: () => undefined }),
        useSearchParams: () => new URLSearchParams("sort=lastActivity&dir=desc"),
      };
    }
    if (request === "next/dynamic") {
      return () => function DynamicStub() {
        return null;
      };
    }
    if (request === "@/app/lib/auth") {
      return {
        requireUser: async () => ({ groups: [] }),
        isAdmin: () => false,
      };
    }
    if (request === "@/app/lib/feature-flags") {
      return { redirectIfFeatureDisabled: async () => undefined };
    }
    if (request === "@/app/lib/db") {
      return {
        query: async (sql: string) => {
          if (sql.includes("date_trunc('day', started_at)")) {
            return [];
          }
          if (sql.includes("active_total")) {
            return [{ active_total: 1, inactive_total: 0, all_total: 1 }];
          }
          if (sql.includes("COUNT(*)::int AS total")) {
            return [{ total: 1 }];
          }
          if (sql.includes("COUNT(DISTINCT user_id)::int AS unique_users")) {
            return [{ unique_users: 0 }];
          }
          if (sql.includes("COUNT(*)::int AS count")) {
            return [{ count: 0 }];
          }
          return [];
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  testGlobals.__psDashboardFilterMocksRegistered = true;
}

const { default: ActivityPage } = require("../app/dashboard/activity/page") as typeof import("../app/dashboard/activity/page");
const { default: UsersPage } = require("../app/dashboard/users/page") as typeof import("../app/dashboard/users/page");
const { default: AgentsPage } = require("../app/dashboard/agents/page") as typeof import("../app/dashboard/agents/page");
const { default: CopilotPage } = require("../app/dashboard/copilot/page") as typeof import("../app/dashboard/copilot/page");

test("activity page renders applied filter tags for site type, window, and page size", async () => {
  const page = await ActivityPage({
    searchParams: Promise.resolve({ siteType: "personal", days: "30" }),
  });
  const markup = renderToStaticMarkup(page);

  assert.match(markup, /Site type: Personal/);
  assert.match(markup, /Activity window: 30d/);
  assert.match(markup, /Page size: 50/);
  assert.match(markup, /href="\/dashboard\/activity"[^>]*>Reset/);
});

test("users page renders applied filter tags for status, activity window, and search", async () => {
  const page = await UsersPage({
    searchParams: Promise.resolve({ q: "alice", status: "inactive", days: "7" }),
  });
  const markup = renderToStaticMarkup(page);

  assert.match(markup, /Search: alice/);
  assert.match(markup, /User status: Inactive/);
  assert.match(markup, /Activity window: 7d/);
  assert.match(markup, /href="\/dashboard\/users"[^>]*>Reset/);
});

test("agents page renders applied filter tags for range, agent, channel, and test data", async () => {
  const page = await AgentsPage({
    searchParams: Promise.resolve({ hours: "720", agent: "*", channel: "*", test: "false" }),
  });
  const markup = renderToStaticMarkup(page);

  assert.match(markup, /Time range: 30 days/);
  assert.match(markup, /Agent: All Agents/);
  assert.match(markup, /Channel: All Channels/);
  assert.match(markup, /Test data: Production Only/);
  assert.match(markup, /href="\/dashboard\/agents"[^>]*>Reset/);
});

test("copilot page renders the shared applied filter tag treatment", async () => {
  const page = await CopilotPage({
    searchParams: Promise.resolve({ period: "D90" }),
  });
  const markup = renderToStaticMarkup(page);

  assert.match(markup, /Report period/);
  assert.match(markup, /Report period: 90 days/);
  assert.match(markup, /href="\/dashboard\/copilot"[^>]*>Reset/);
});

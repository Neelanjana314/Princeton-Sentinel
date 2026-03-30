import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const Module = require("node:module");
const testGlobals = globalThis as typeof globalThis & {
  __psTmpAliasRegistered?: boolean;
  __psNextNavigationMocked?: boolean;
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

if (!testGlobals.__psNextNavigationMocked) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (request === "next/navigation") {
      return {
        usePathname: () => "/dashboard/users",
        useRouter: () => ({ push: () => undefined }),
        useSearchParams: () => new URLSearchParams("sort=user&dir=asc"),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  testGlobals.__psNextNavigationMocked = true;
}

const { UsersTable } = require("../app/dashboard/users/users-table") as typeof import("../app/dashboard/users/users-table");

test("users table renders directory columns and row links without days params", () => {
  const markup = renderToStaticMarkup(
    React.createElement(UsersTable, {
      items: [
        {
          user_id: "user-123",
          display_name: "Alice Admin",
          mail: "alice@example.com",
          user_principal_name: "alice@example.com",
          user_type: "Member",
          department: "IT",
          job_title: "Administrator",
          created_dt: "2026-03-28T10:00:00.000Z",
        },
      ],
    })
  );

  assert.match(markup, /User Type/);
  assert.match(markup, /Department/);
  assert.match(markup, /Job Title/);
  assert.match(markup, /Created/);
  assert.match(markup, /href="\/dashboard\/users\/user-123"/);
  assert.doesNotMatch(markup, /days=/);
});

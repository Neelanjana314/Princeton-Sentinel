import { test } from "node:test";
import assert from "node:assert/strict";

import { navigateBack } from "../components/history-back-button";

test("navigateBack uses browser history when a previous entry exists", () => {
  let backCalls = 0;
  const pushes: string[] = [];

  navigateBack(
    {
      back: () => {
        backCalls += 1;
      },
      push: (href: string) => {
        pushes.push(href);
      },
    },
    2,
    "/dashboard/sites"
  );

  assert.equal(backCalls, 1);
  assert.deepEqual(pushes, []);
});

test("navigateBack falls back to the provided route when history is unavailable", () => {
  let backCalls = 0;
  const pushes: string[] = [];

  navigateBack(
    {
      back: () => {
        backCalls += 1;
      },
      push: (href: string) => {
        pushes.push(href);
      },
    },
    1,
    "/dashboard/sites"
  );

  assert.equal(backCalls, 0);
  assert.deepEqual(pushes, ["/dashboard/sites"]);
});

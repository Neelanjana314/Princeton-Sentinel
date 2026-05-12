const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".tmp-tests");
const testsDir = path.join(outDir, "tests");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function collectTests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectTests(fullPath);
      return entry.isFile() && entry.name.endsWith(".test.js") ? [fullPath] : [];
    })
    .sort();
}

fs.rmSync(outDir, { force: true, recursive: true });
run(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.test.json"]);

const tests = collectTests(testsDir);
process.env.PRINCETON_SENTINEL_DISABLE_KEY_VAULT_RUNTIME = "true";
run("node", ["--test", ...tests]);

fs.rmSync(outDir, { force: true, recursive: true });

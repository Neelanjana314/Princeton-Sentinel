#!/usr/bin/env node

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(version) {
  const match = SEMVER_PATTERN.exec(String(version || "").trim());
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function compareVersions(leftVersion, rightVersion) {
  const left = parseVersion(leftVersion);
  const right = parseVersion(rightVersion);

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] > right[index]) {
      return 1;
    }
    if (left[index] < right[index]) {
      return -1;
    }
  }

  return 0;
}

function normalizeYamlScalar(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function extractVersionFromWorkflow(contents) {
  const lines = String(contents).split(/\r?\n/);
  let insideTopLevelEnv = false;

  for (const line of lines) {
    if (!insideTopLevelEnv) {
      if (line === "env:") {
        insideTopLevelEnv = true;
      }
      continue;
    }

    if (/^\S/.test(line)) {
      break;
    }

    const match = /^  STAGING_VERSION:\s*(.+?)\s*$/.exec(line);
    if (match) {
      const version = normalizeYamlScalar(match[1]);
      parseVersion(version);
      return version;
    }
  }

  throw new Error("Missing top-level env.STAGING_VERSION in deploy-staging.yml");
}

function readVersionFromFile(filePath) {
  return extractVersionFromWorkflow(fs.readFileSync(filePath, "utf8"));
}

function readVersionFromGit(revision, filePath) {
  const contents = execFileSync("git", ["show", `${revision}:${filePath}`], { encoding: "utf8" });
  return extractVersionFromWorkflow(contents);
}

function readVersionFromGitOrDefault(revision, filePath, defaultVersion) {
  parseVersion(defaultVersion);

  try {
    return readVersionFromGit(revision, filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Missing top-level env.STAGING_VERSION")) {
      return defaultVersion;
    }
    throw error;
  }
}

function main(argv) {
  const [, , command, ...args] = argv;

  switch (command) {
    case "from-file":
      if (args.length !== 1) {
        throw new Error("Usage: staging-version.cjs from-file <path>");
      }
      process.stdout.write(readVersionFromFile(args[0]));
      return;
    case "from-git":
      if (args.length !== 2) {
        throw new Error("Usage: staging-version.cjs from-git <revision> <path>");
      }
      process.stdout.write(readVersionFromGit(args[0], args[1]));
      return;
    case "compare":
      if (args.length !== 2) {
        throw new Error("Usage: staging-version.cjs compare <left> <right>");
      }
      {
        const comparison = compareVersions(args[0], args[1]);
        const result = comparison > 0 ? "gt" : comparison < 0 ? "lt" : "eq";
        process.stdout.write(result);
      }
      return;
    case "from-git-or-default":
      if (args.length !== 3) {
        throw new Error("Usage: staging-version.cjs from-git-or-default <revision> <path> <default>");
      }
      process.stdout.write(readVersionFromGitOrDefault(args[0], args[1], args[2]));
      return;
    default:
      throw new Error("Usage: staging-version.cjs <from-file|from-git|from-git-or-default|compare> ...");
  }
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}

module.exports = {
  compareVersions,
  extractVersionFromWorkflow,
  parseVersion,
  readVersionFromGitOrDefault,
};

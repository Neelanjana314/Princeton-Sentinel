#!/usr/bin/env node

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || "").trim());
  if (!match) {
    throw new Error(`Invalid semantic version: ${version}`);
  }

  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
  };
}

function resolveReleaseType(releaseType, commitTitle) {
  if (releaseType && releaseType !== "auto") {
    return releaseType;
  }

  return String(commitTitle || "").trim().toLowerCase().startsWith("feat:") ? "minor" : "patch";
}

function bumpVersion(currentVersion, releaseType, commitTitle) {
  const version = parseVersion(currentVersion);
  const effectiveReleaseType = resolveReleaseType(releaseType, commitTitle);

  switch (effectiveReleaseType) {
    case "major":
      return `${version.major + 1}.0.0`;
    case "minor":
      return `${version.major}.${version.minor + 1}.0`;
    case "patch":
      return `${version.major}.${version.minor}.${version.patch + 1}`;
    default:
      throw new Error(`Unsupported release type: ${effectiveReleaseType}`);
  }
}

if (require.main === module) {
  const [, , currentVersion, releaseType = "auto", commitTitle = ""] = process.argv;
  process.stdout.write(bumpVersion(currentVersion, releaseType, commitTitle));
}

module.exports = {
  bumpVersion,
  parseVersion,
  resolveReleaseType,
};

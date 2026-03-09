import fs from "node:fs";
import path from "node:path";

let cachedPackageVersion: string | null = null;

function getPackageVersion() {
  if (cachedPackageVersion) {
    return cachedPackageVersion;
  }

  try {
    const packageJsonPath = path.join(process.cwd(), "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
    if (packageJson.version) {
      cachedPackageVersion = packageJson.version;
      return cachedPackageVersion;
    }
  } catch {
    // Fall through to the default version when package.json cannot be read.
  }

  return "0.0.0";
}

export function getAppVersion() {
  return process.env.APP_VERSION || getPackageVersion();
}

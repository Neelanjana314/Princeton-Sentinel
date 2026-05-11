const path = require("node:path");
const { hydrateEnvFromKeyVault, loadManifest } = require("./key-vault-env.cjs");

async function main() {
  const manifest = loadManifest(path.join(__dirname, "runtime-env-manifest.json"));
  await hydrateEnvFromKeyVault({ service: "web", manifest });
  require("./server.js");
}

main().catch((error) => {
  console.error(`Startup Key Vault hydration failed: ${error.message}`);
  process.exit(1);
});


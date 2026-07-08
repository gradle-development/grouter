const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const { getRuntimeNodeModules, summarizeNpmError } = require("./sqliteRuntime");
const {
  PATCHRIGHT_VERSION,
  ensureAutomationRuntimeDir,
  getAutomationRuntimeDir,
  getAutomationRuntimeNodeModules,
  installAutomationPackages,
  requireAutomationPackage,
} = require("./automationRuntime");

const PATCHRIGHT_PACKAGE = "patchright";
let cachedReady = null;

function requirePackageFromDir(packageDir, packageName) {
  try {
    return createRequire(path.join(packageDir, "package.json"))(packageName);
  } catch {
    return null;
  }
}

function tryRequirePatchright() {
  try { return requireAutomationPackage(PATCHRIGHT_PACKAGE); } catch {}
  try {
    const candidate = path.join(getRuntimeNodeModules(), PATCHRIGHT_PACKAGE);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return requirePackageFromDir(candidate, PATCHRIGHT_PACKAGE);
    }
  } catch {}
  try { return require(PATCHRIGHT_PACKAGE); } catch {}
  return null;
}

function ensurePatchrightPackage({ silent = false } = {}) {
  ensureAutomationRuntimeDir();
  const existing = tryRequirePatchright();
  if (existing) return { ok: true, module: existing };
  if (!silent) console.log("Installing patchright browser engine...");
  const installed = installAutomationPackages([`${PATCHRIGHT_PACKAGE}@${PATCHRIGHT_VERSION}`], { silent, timeout: 300_000 });
  if (!installed.ok) {
    return { ok: false, reason: `npm install patchright failed: ${summarizeNpmError(installed.stderr)}` };
  }
  const mod = tryRequirePatchright();
  return mod ? { ok: true, module: mod } : { ok: false, reason: "patchright installed but cannot be required" };
}

function ensurePatchrightRuntime({ silent = false } = {}) {
  if (cachedReady === true) return { ok: true, module: tryRequirePatchright() };
  const pkg = ensurePatchrightPackage({ silent });
  if (!pkg.ok) {
    cachedReady = false;
    const error = new Error(`Patchright engine not available. ${pkg.reason}. Fix ${getAutomationRuntimeDir()}, then retry.`);
    error.code = "PATCHRIGHT_PACKAGE_MISSING";
    return { ok: false, error };
  }
  cachedReady = true;
  return pkg;
}

function installPatchrightOnly({ silent = false, timeout = 300_000 } = {}) {
  ensureAutomationRuntimeDir();
  const installed = installAutomationPackages([`${PATCHRIGHT_PACKAGE}@${PATCHRIGHT_VERSION}`], { silent, timeout });
  if (!installed.ok) return { ok: false, reason: summarizeNpmError(installed.stderr) };
  return tryRequirePatchright() ? { ok: true } : { ok: false, reason: "patchright installed but cannot be required" };
}

function loadPatchrightModule() {
  return tryRequirePatchright();
}

module.exports = {
  ensurePatchrightRuntime,
  installPatchrightOnly,
  loadPatchrightModule,
};

const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const { summarizeNpmError } = require("./sqliteRuntime");
const {
  CLOAKBROWSER_VERSION,
  ensureAutomationRuntimeDir,
  getAutomationRuntimeDir,
  getAutomationRuntimeNodeModules,
  installAutomationPackages,
  requireAutomationPackage,
} = require("./automationRuntime");

const CLOAKBROWSER_PACKAGE = "cloakbrowser";
let cachedReady = null;

function requirePackageFromDir(packageDir, packageName) {
  try {
    return createRequire(path.join(packageDir, "package.json"))(packageName);
  } catch {
    return null;
  }
}

function tryRequireCloakBrowser() {
  try { return requireAutomationPackage(CLOAKBROWSER_PACKAGE); } catch {}
  try {
    const candidate = path.join(getAutomationRuntimeNodeModules(), CLOAKBROWSER_PACKAGE);
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return requirePackageFromDir(candidate, CLOAKBROWSER_PACKAGE);
    }
  } catch {}
  try { return require(CLOAKBROWSER_PACKAGE); } catch {}
  return null;
}

function isCloakBrowserInstalled() {
  if (tryRequireCloakBrowser()) return true;
  try {
    const candidate = path.join(getAutomationRuntimeNodeModules(), CLOAKBROWSER_PACKAGE);
    return fs.existsSync(path.join(candidate, "package.json"));
  } catch {
    return false;
  }
}

function ensureCloakBrowserPackage({ silent = false } = {}) {
  ensureAutomationRuntimeDir();
  if (isCloakBrowserInstalled()) return { ok: true, module: null, esm: true };
  if (!silent) console.log("Installing cloakbrowser engine...");
  const installed = installAutomationPackages([`${CLOAKBROWSER_PACKAGE}@${CLOAKBROWSER_VERSION}`], { silent, timeout: 300_000 });
  if (!installed.ok) {
    return { ok: false, reason: `npm install cloakbrowser failed: ${summarizeNpmError(installed.stderr)}` };
  }
  return isCloakBrowserInstalled()
    ? { ok: true, module: null, esm: true }
    : { ok: false, reason: "cloakbrowser installed but not found in automation runtime dir" };
}

function ensureCloakBrowserRuntime({ silent = false } = {}) {
  if (cachedReady === true) return { ok: true, module: null, esm: true };
  const pkg = ensureCloakBrowserPackage({ silent });
  if (!pkg.ok) {
    cachedReady = false;
    const error = new Error(`CloakBrowser engine not available. ${pkg.reason}. Fix ${getAutomationRuntimeDir()}, then retry.`);
    error.code = "CLOAKBROWSER_PACKAGE_MISSING";
    return { ok: false, error };
  }
  cachedReady = true;
  return pkg;
}

function installCloakBrowserOnly({ silent = false, timeout = 300_000 } = {}) {
  ensureAutomationRuntimeDir();
  const installed = installAutomationPackages([`${CLOAKBROWSER_PACKAGE}@${CLOAKBROWSER_VERSION}`], { silent, timeout });
  if (!installed.ok) return { ok: false, reason: summarizeNpmError(installed.stderr) };
  return isCloakBrowserInstalled() ? { ok: true } : { ok: false, reason: "cloakbrowser installed but not found in automation runtime dir" };
}

function loadCloakBrowserModule() {
  return tryRequireCloakBrowser();
}

async function loadCloakBrowserModuleAsync() {
  const sync = tryRequireCloakBrowser();
  if (sync) return sync;
  try {
    const candidate = path.join(getAutomationRuntimeNodeModules(), CLOAKBROWSER_PACKAGE);
    let entryPath;
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      const pkg = JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8"));
      entryPath = path.join(candidate, pkg.main || pkg.module || "dist/index.js");
    } else {
      const resolved = require.resolve(CLOAKBROWSER_PACKAGE);
      entryPath = resolved;
    }
    const mod = await import(require("url").pathToFileURL(entryPath).href);
    return mod?.default || mod;
  } catch (err) {
    console.log("[cloakbrowser] async load failed:", err.message);
    return null;
  }
}

module.exports = {
  ensureCloakBrowserRuntime,
  installCloakBrowserOnly,
  loadCloakBrowserModule,
  loadCloakBrowserModuleAsync,
};

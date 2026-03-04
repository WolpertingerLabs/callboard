#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const mode = process.argv[2]; // 'local' | 'prod' | 'which' | 'check'
const PKG = "@wolpertingerlabs/drawlatch";
const ROOT = path.resolve(__dirname, "..");
const DRAWLATCH_DIR = path.resolve(ROOT, "../drawlatch");

/** Read, patch, and write a package.json dependency version */
function setVersion(relPath, version) {
  const filePath = path.resolve(ROOT, relPath);
  const pkg = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const prev = pkg.dependencies[PKG];
  pkg.dependencies[PKG] = version;
  fs.writeFileSync(filePath, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`  ${relPath}: ${prev} -> ${version}`);
}

/** Read drawlatch's own version from its package.json */
function getDrawlatchVersion() {
  const pkgPath = path.resolve(DRAWLATCH_DIR, "package.json");
  if (!fs.existsSync(pkgPath)) {
    console.error(`Error: drawlatch package.json not found at ${pkgPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
}

switch (mode) {
  case "local": {
    console.log("Switching drawlatch to local (file:../drawlatch) ...");
    setVersion("package.json", "file:../drawlatch");
    setVersion("backend/package.json", "file:../../drawlatch");
    break;
  }

  case "prod": {
    const ver = `^${getDrawlatchVersion()}`;
    console.log(`Switching drawlatch to prod (${ver}) ...`);
    setVersion("package.json", ver);
    setVersion("backend/package.json", ver);
    break;
  }

  case "check": {
    const files = ["package.json", "backend/package.json"];
    const locals = [];
    for (const f of files) {
      const p = JSON.parse(
        fs.readFileSync(path.resolve(ROOT, f), "utf8"),
      );
      const ver = p.dependencies[PKG];
      if (ver && ver.startsWith("file:")) {
        locals.push(`  ${f}: ${ver}`);
      }
    }
    if (locals.length > 0) {
      console.error(
        "Error: Cannot publish with local drawlatch references:\n" +
          locals.join("\n") +
          '\n\nRun "npm run drawlatch:prod" to switch back before publishing.',
      );
      process.exit(1);
    }
    console.log("Publish check passed: no local drawlatch references.");
    break;
  }

  case "which": {
    const rootPkg = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, "package.json"), "utf8"),
    );
    const backendPkg = JSON.parse(
      fs.readFileSync(path.resolve(ROOT, "backend/package.json"), "utf8"),
    );
    const rootVer = rootPkg.dependencies[PKG];
    const backendVer = backendPkg.dependencies[PKG];
    const isLocal = rootVer.startsWith("file:");
    console.log(`Mode:    ${isLocal ? "local" : "prod"}`);
    console.log(`Root:    ${rootVer}`);
    console.log(`Backend: ${backendVer}`);
    break;
  }

  default:
    console.error(
      "Usage: node scripts/drawlatch-switch.cjs <local|prod|which|check>",
    );
    process.exit(1);
}

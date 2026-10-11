/**
 * Build a Windows installer for the insurance-verification-only app.
 * Distinct appId + productName so it installs beside Billing and Billing Clone.
 *
 * Silent / programmatic install:
 *   "Diet Fantasy Insurance Setup X.Y.Z.exe" /S
 *   "Diet Fantasy Insurance Setup X.Y.Z.exe" /S /D=C:\Apps\DFInsurance
 *   (/D must be last; no quotes around the path)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const configPath = path.join(root, 'electron-builder.insurance.json');
const modePath = path.join(root, 'src', 'app-mode.json');

const BILLING_MODE = { mode: 'billing' };
const INSURANCE_MODE = { mode: 'insurance' };

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

const prevMode = fs.existsSync(modePath) ? fs.readFileSync(modePath, 'utf8') : null;

const cloneBuild = {
  ...pkg.build,
  appId: 'com.dietfantasy.insurance-verification',
  productName: 'Diet Fantasy Insurance',
  artifactName: 'Diet Fantasy Insurance Setup ${version}.${ext}',
  directories: {
    ...(pkg.build.directories || {}),
    output: 'dist-insurance'
  },
  nsis: {
    ...(pkg.build.nsis || {}),
    shortcutName: 'Diet Fantasy Insurance',
    uninstallDisplayName: 'Diet Fantasy Insurance'
  }
};

try {
  writeJson(modePath, INSURANCE_MODE);
  writeJson(configPath, cloneBuild);
  console.log('[pack-win-insurance] app-mode.json → insurance');
  console.log('[pack-win-insurance] appId:', cloneBuild.appId);
  console.log('[pack-win-insurance] productName:', cloneBuild.productName);
  console.log('[pack-win-insurance] output:', cloneBuild.directories.output);

  execSync(
    'npx cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win --config electron-builder.insurance.json',
    { cwd: root, stdio: 'inherit', env: process.env }
  );
} finally {
  if (prevMode != null) {
    fs.writeFileSync(modePath, prevMode);
  } else {
    writeJson(modePath, BILLING_MODE);
  }
  console.log('[pack-win-insurance] Restored src/app-mode.json to billing (or previous value)');
}

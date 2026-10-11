/**
 * Build a side-by-side Windows clone installer.
 * Distinct appId + productName so it installs next to "Diet Fantasy Billing"
 * without overwriting it (separate uninstall entry + userData folder).
 *
 * Silent / programmatic install:
 *   "Diet Fantasy Billing Clone Setup X.Y.Z.exe" /S
 *   "Diet Fantasy Billing Clone Setup X.Y.Z.exe" /S /D=C:\Apps\DFBillingClone
 *   (/D must be last; no quotes around the path)
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const configPath = path.join(root, 'electron-builder.clone.json');

const cloneBuild = {
  ...pkg.build,
  appId: 'com.dietfantasy.billing-automation-clone',
  productName: 'Diet Fantasy Billing Clone',
  artifactName: 'Diet Fantasy Billing Clone Setup ${version}.${ext}',
  directories: {
    ...(pkg.build.directories || {}),
    output: 'dist-clone'
  },
  nsis: {
    ...(pkg.build.nsis || {}),
    shortcutName: 'Diet Fantasy Billing Clone',
    uninstallDisplayName: 'Diet Fantasy Billing Clone'
  }
};

fs.writeFileSync(configPath, JSON.stringify(cloneBuild, null, 2) + '\n');
console.log('[pack-win-clone] Wrote', configPath);
console.log('[pack-win-clone] appId:', cloneBuild.appId);
console.log('[pack-win-clone] productName:', cloneBuild.productName);
console.log('[pack-win-clone] output:', cloneBuild.directories.output);

execSync('npx cross-env CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --win --config electron-builder.clone.json', {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});

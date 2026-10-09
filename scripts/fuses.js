'use strict';

// Flips Electron's compile-time "fuses" in the packaged binary so it can't be repurposed
// (e.g. run as plain Node, or load code outside app.asar). Called from scripts/after-pack.js
// before code signing, so the final signature covers the flipped binary.

const path = require('path');

exports.default = async function flipAppFuses(context) {
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const { electronPlatformName: platform, appOutDir, packager } = context;
  const name = packager.appInfo.productFilename;

  const target = {
    darwin: () => path.join(appOutDir, `${name}.app`),
    win32: () => path.join(appOutDir, `${name}.exe`),
    linux: () => path.join(appOutDir, packager.executableName),
  }[platform]();

  await flipFuses(target, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  });
};

/**
 * Fuses are baked into the packaged Electron binary and cannot be changed at
 * runtime. They close the escape hatches that a compromised renderer or a local
 * attacker would otherwise reach for.
 *
 * electron-builder flips these itself and validates the object against its own
 * schema, so the keys are its camelCase names rather than the `FuseV1Options`
 * enum from @electron/fuses.
 */
const electronFuses = {
  // The shipped binary cannot be re-used as a general purpose Node runtime.
  runAsNode: false,
  enableCookieEncryption: true,
  // NODE_OPTIONS and --inspect would both let a local process inject code
  // straight into the main process.
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  // Refuse to start if app.asar has been tampered with, and never fall back to
  // loading the app from a loose directory next to the binary.
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  loadBrowserProcessSpecificV8Snapshot: false,
  // The renderer is served over chiagaming://, so file:// needs no privileges.
  grantFileProtocolExtraPrivileges: false,
  // Flipping fuses rewrites the binary, which invalidates whatever signature it
  // carried. When a Developer ID is configured electron-builder re-signs right
  // afterwards, but on a machine without one the app keeps a broken ad-hoc
  // signature and Apple Silicon kills it at launch with no output at all.
  resetAdHocDarwinSignature: true,
};

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'org.chia.gaming.desktop',
  productName: 'Chia Gaming',
  // Not the conventional 'build' directory: the repository-wide .gitignore
  // excludes build/, which would drop the entitlements file from the repo.
  directories: { output: 'release', buildResources: 'packaging' },
  afterPack: './packaging/afterPack.cjs',
  // Only built output ships. The main and preload bundles are self-contained, so
  // no node_modules tree is packaged. Sourcemaps are built for `pnpm start` but
  // are megabytes of dead weight in an installer.
  files: [
    'dist/main/**/*',
    'dist/preload/**/*',
    'dist/renderer/**/*',
    'package.json',
    '!dist/**/*.map',
  ],
  // Nothing is unpacked: appProtocol.ts reads assets through Node's fs, which is
  // asar-aware, so the whole renderer stays under the integrity fuse above.
  asar: true,
  electronFuses,
  mac: {
    category: 'public.app-category.games',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'packaging/entitlements.mac.plist',
    entitlementsInherit: 'packaging/entitlements.mac.plist',
    target: [{ target: 'dmg' }, { target: 'zip' }],
  },
  // Notarization and signing identities are release-time concerns; configure
  // Apple credentials in CI before enabling them.
  win: { target: [{ target: 'nsis' }] },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
  },
  linux: {
    target: [{ target: 'AppImage' }, { target: 'deb' }],
    category: 'Game',
    maintainer: 'Chia Network',
    syncDesktopName: true,
  },
};

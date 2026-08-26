'use strict';

// electron-builder afterPack hook: runs after the app is packed, before
// codesign. macOS stamps a `com.apple.provenance` extended attribute on
// executables it writes, and codesign then rejects the bundle with "resource
// fork, Finder information, or similar detritus not allowed". Clearing all
// extended attributes immediately before signing avoids it on any build host.

const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  try {
    execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'ignore' });
  } catch {
    // Best-effort: if this was actually needed, signing will say so.
  }
};

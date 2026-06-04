'use strict';

// electron-builder afterPack hook (runs after the app is packed, before
// codesign). Modern macOS stamps a `com.apple.provenance` extended attribute
// on executables it writes; `codesign` then rejects the bundle with
// "resource fork, Finder information, or similar detritus not allowed".
// Stripping all extended attributes from the packaged app immediately before
// signing avoids this on any macOS build host.

const { execFileSync } = require('node:child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  try {
    execFileSync('xattr', ['-cr', context.appOutDir], { stdio: 'ignore' });
  } catch {
    // Best-effort: signing will surface any real problem.
  }
};

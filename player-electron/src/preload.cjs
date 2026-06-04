'use strict';

// The renderer is the unmodified web bundle. The only thing it needs to know
// is that it is running inside the packaged Electron distribution, so it can
// hide web-only affordances (e.g. the local simulator connection option).
//
// This flag is set at preload evaluation time, before any renderer script
// runs, so React can read it synchronously during the first render.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('__chiaDistribution', 'electron');

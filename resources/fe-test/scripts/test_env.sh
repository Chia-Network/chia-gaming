#!/bin/sh

FRONTEND_JS=/app/dist/js/index-rollup.js

# Static content comes from nginx
(nginx -g "daemon off;" &)

# Patch the frontend code for use in the test rig
sed -e 's/https:\/\/api.coinset.org/http:\/\/localhost:3002/g' < "${FRONTEND_JS}" > /tmp/index-rollup.js
mv /tmp/index-rollup.js "${FRONTEND_JS}"

# Run the walletconnect simulator
(cd /app/wc && node ./dist/index.js &)

# Run the lobby service provider
(cd /app/lobby-service && node ./dist/index-rollup.cjs --self http://localhost:3001 &)

# Run the beacon which tells the tracker about the game
(/app/beacon.sh http://localhost:3000 http://localhost:3001 &)

# Run the simulator (must be last)
. /app/test/bin/activate && RUST_LOG=debug python3 run_simulator.py

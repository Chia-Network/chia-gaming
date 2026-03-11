#!/bin/bash
set -e
set -x

GAME_PORT=${GAME_PORT:-3002}
LOBBY_PORT=${LOBBY_PORT:-3003}
WC_PORT=${WC_PORT:-3004}
SIM_PORT=${SIM_PORT:-5800}
LOBBY_SERVICE_PORT=${LOBBY_SERVICE_PORT:-5801}

cleanup() {
    echo ""
    echo "=== Stopping all services ==="
    nginx -s stop 2>/dev/null || true
    kill $(jobs -p) 2>/dev/null || true
    echo "All services stopped."
}
trap cleanup EXIT

# ── Nginx config (substitute ports at runtime) ──────────────────────
sed -e "s!@PORT@!${GAME_PORT}!g" < /etc/nginx/templates/game.conf \
    > /etc/nginx/sites-enabled/game.conf
sed -e "s!@PORT@!${LOBBY_PORT}!g" < /etc/nginx/templates/lobby.conf \
    > /etc/nginx/sites-enabled/lobby.conf

# Patch frontend JS for test rig if requested
FRONTEND_JS=/app/dist/js/index-rollup.js
if [ "x$1" = "xrewrite" ] ; then
    sed -e 's|https://api.coinset.org|http://localhost:3002|g' \
        < "${FRONTEND_JS}" > /tmp/index-rollup.js
    mv /tmp/index-rollup.js "${FRONTEND_JS}"
fi

# ── Start services (same order as run-local-demo.sh) ────────────────

echo "=== Starting nginx ==="
nginx -g "daemon off;" &

echo "=== Starting simulator (port ${SIM_PORT}) ==="
RUST_LOG=debug /app/rust/target/debug/chia-gaming-sim &

echo "=== Waiting for simulator ==="
for i in $(seq 1 30); do
    if curl -s -X POST "http://localhost:${SIM_PORT}/get_peak" >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    sleep 1
done

if ! curl -s -X POST "http://localhost:${SIM_PORT}/get_peak" >/dev/null 2>&1; then
    echo "Simulator failed to start within 30 seconds"
    exit 1
fi

echo "=== Starting wc-stub (port ${WC_PORT}) ==="
(cd /app/wc && PORT=${WC_PORT} node ./dist/index.js) &

echo "=== Starting lobby-service (port ${LOBBY_SERVICE_PORT}) ==="
(cd /app/lobby-service && PORT=${LOBBY_SERVICE_PORT} node ./dist/index-rollup.cjs --self "http://localhost:${LOBBY_PORT}") &

echo "=== Starting beacon ==="
/app/beacon.sh "http://localhost:${GAME_PORT}" "http://localhost:${LOBBY_PORT}" &

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All services running:"
echo "    Game frontend:    http://localhost:${GAME_PORT}"
echo "    Lobby view:       http://localhost:${LOBBY_PORT}"
echo "    WC stub:          http://localhost:${WC_PORT}"
echo "    Simulator:        http://localhost:${SIM_PORT}"
echo "    Lobby service:    http://localhost:${LOBBY_SERVICE_PORT}"
echo "════════════════════════════════════════════════════════"
echo ""

wait

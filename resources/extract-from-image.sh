#!/bin/bash -x

if [ "x$1" = x ] ; then
    echo "usage: extract-from-image.sh target"
    exit 1
fi

export VERSION="$(./resources/get_chia_gaming_version.py)"
export SOURCE="$1/artifacts"
export TARGET="$1/chia-gaming-deploy"
export SHORT_GAME="chia-gaming-game"
export SHORT_LOBBY="chia-gaming-lobby"
export GAME="${TARGET}/g/${SHORT_GAME}"
export LOBBY="${TARGET}/l/${SHORT_LOBBY}"

mkdir -p "${SOURCE}/app"
mkdir -p "${SOURCE}/nginx"
mkdir -p "${GAME}/dist/js"
mkdir -p "${GAME}/public"
mkdir -p "${GAME}/clsp"
mkdir -p "${GAME}/nginx"

docker run -v "${SOURCE}:/artifacts" -t chia-gaming-test /bin/bash -c "cp -r /app/* /artifacts/app"

cp -r "${SOURCE}/app/game/dist"/*.* "${GAME}/dist"
cp -r "${SOURCE}/app/game/dist/js/index.js" "${GAME}/dist/js"
cp -r "${SOURCE}/app/game/public"/* "${GAME}/public"
cp -r "${SOURCE}/app/clsp"/* "${GAME}/clsp"

cp -r resources/nginx/game.conf "${GAME}/nginx"
cp -r resources/nginx/beacon.sh "${GAME}/beacon.sh"
cp -r resources/nginx/game-install.sh "${GAME}/game-install.sh"
cp -r resources/nginx/beacon.service "${GAME}/beacon.service"
cp -r resources/nginx/GAME.md "${GAME}/README.md"

mkdir -p "${LOBBY}/public"
mkdir -p "${LOBBY}/nginx"

cp -r "${SOURCE}/app/lobby-view/public"/* "${LOBBY}/public"
cp -r "${SOURCE}/app/lobby-service/dist/index.js" "${LOBBY}/service.js"

cp -r resources/nginx/lobby-install.sh "${LOBBY}/lobby-install.sh"
cp -r resources/nginx/lobby.service "${LOBBY}/lobby.service"
cp -r resources/nginx/lobby.conf "${LOBBY}/nginx"
cp -r resources/nginx/LOBBY.md "${LOBBY}/README.md"

#!/bin/bash

set -x
set -e

yarn install --dev

docker kill chia-gaming-test || true
docker rm chia-gaming-test || true
docker run --name chia-gaming-test -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:3002:3002 -p 127.0.0.1:5800:5800  -t chia-gaming-test /bin/bash -c "/app/test_env.sh --coinset http://localhost:3002" &

if [ -z "$FIREFOX" ]; then
  case $(uname) in
  Darwin)
    export FIREFOX=/Applications/Firefox.app/Contents/MacOS
    ;;
  *)
    echo "Please set env var 'FIREFOX'";;
  esac
else
  echo "Using env var FIREFOX=${FIREFOX}"
fi

wait_for_port() {
  url="$1"
  curl --connect-timeout 5 \
    --max-time 10 \
    --retry 10 \
    --retry-delay 0 \
    --retry-max-time 40 \
    --retry-all-errors \
    ${url}
}

wait_for_port http://localhost:3000
wait_for_port http://localhost:3001

# Enable coinset url rewriting
curl --retry 5 --retry-delay 1 --retry-all-errors -H "Content-Type: text/plain" -d http://localhost:3002 http://localhost:3000/coinset

echo 'running tests'
STATUS=1
if ./node_modules/.bin/jest ; then
    STATUS=0
else
    STATUS=1
fi

echo 'cleaning up'
docker kill chia-gaming-test
docker rm chia-gaming-test

exit ${STATUS}

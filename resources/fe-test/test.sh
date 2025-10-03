#!/bin/bash

set -x
set -e

yarn install --dev

docker kill chia-gaming-test || true
docker rm chia-gaming-test || true
docker run --name chia-gaming-test -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:5800:5800  -t chia-gaming-test &

if [ -z "$FIREFOX" ]; then
  case $(uname) in
  Darwin)
    export FIREFOX=/Applications/Firefox.app/Contents/MacOS
    sleep 13
    ;;
  *)
    echo "Please set env var 'FIREFOX'";;
  esac
else
  echo "Using env var FIREFOX=${FIREFOX}"
fi

echo 'waiting for service alive .'
/bin/bash ./wait-for-it.sh -t 90 -h localhost -p 3000
echo 'waiting for service alive ..'
/bin/bash ./wait-for-it.sh -t 90 -h localhost -p 3001
echo 'waiting for service alive ...'
/bin/bash ./wait-for-it.sh -t 90 -h localhost -p 5800

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

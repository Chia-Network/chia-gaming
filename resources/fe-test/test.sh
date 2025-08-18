#!/bin/bash

set -e

yarn install --dev

docker kill chia-gaming-test || true
docker rm chia-gaming-test || true
docker run --name chia-gaming-test --network=host -t chia-gaming-test &

echo 'waiting for service alive .'
/bin/bash ./wait-for-it.sh -t 90 -h localhost -p 3000
echo 'waiting for service alive ..'
/bin/bash ./wait-for-it.sh -t 90 -h localhost -p 3001
echo 'waiting for service alive ...'
/bin/bash ./wait-for-it.sh -t 90 -h localhost -p 5800

echo 'running tests'
STATUS=1
if ./node_modules/.bin/jest --silent=false --useStderr ; then
    STATUS=0
else
    STATUS=1
fi

echo 'cleaning up'
docker kill chia-gaming-test
docker rm chia-gaming-test

exit ${STATUS}

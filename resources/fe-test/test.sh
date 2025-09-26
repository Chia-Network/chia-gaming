#!/bin/bash

set -e

yarn install --dev

docker kill chia-gaming-sim || true
docker rm chia-gaming-sim || true
docker run --name chia-gaming-sim --network=host -t chia-gaming-test &

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
docker kill chia-gaming-sim
docker rm chia-gaming-sim

exit ${STATUS}

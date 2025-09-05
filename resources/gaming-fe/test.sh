#!/bin/sh -x

cd /app
(. /app/test/bin/activate && python3 ./run_simulator.py) &
sleep 5
yarn test


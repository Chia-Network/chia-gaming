#!/bin/sh -x

cd /app
(python ./simulator.py) &
sleep 5
yarn test


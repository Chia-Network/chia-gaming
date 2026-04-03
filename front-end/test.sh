#!/bin/sh -x

cd /app/game
(cd /app && RUST_LOG=debug /app/rust/target/debug/chia-gaming-sim) &
sleep 5
pnpm run test


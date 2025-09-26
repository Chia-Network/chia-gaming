#!/bin/bash -x

docker kill chia-gaming-sim
pid_of_3002=$(lsof -i -n -P | grep LISTEN  | grep 3002 | head -1 | awk '{print $2}')

#if [ ! -z "$pid_of_3002" ]; then
#  kill -9 "$pid_of_3002"
#fi

echo Make sure this is running first:
echo '(cd wallet_spend && poetry run python3 demo_wallet_interface.py)'

docker run --platform linux/amd64 -i -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:5800:5800 -t chia-gaming-sim 2>&1 | grep -v 'updating the mempool using the slow-path'



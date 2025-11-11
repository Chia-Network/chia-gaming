#!/bin/sh

if [ "x$1" = x -o "x$2" = x ] ; then
    echo "usage: beacon.sh self_url tracker_url"
    exit 1
fi

SELF_URL="$1"
TRACKER_URL="$2"

POST_CONTENT="{\"game\":\"calpoker\",\"target\":\"${SELF_URL}/?game=calpoker&lobbyUrl=${TRACKER_URL}\"}"

while true ; do
	curl -H "Content-Type: application/json" -d "${POST_CONTENT}" "${TRACKER_URL}/lobby/game"
	sleep 20
done

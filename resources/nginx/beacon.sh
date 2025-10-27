#!/bin/sh

while true ; do
	curl -H "Content-Type: application/json" -d '{"game":"calpoker","target":"http://localhost:3000/?game=calpoker&lobbyUrl=http://localhost:3001"}' http://localhost:3001/lobby/game
	sleep 20
done

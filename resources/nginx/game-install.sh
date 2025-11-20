#!/bin/sh

set -x

NGINX=/etc/nginx/sites-available
WEBROOT=/usr/share/nginx/html/chia-gaming-game
SERVICE=""
TRACKER=""
SELF=""

if [ "x$1" = x ] ; then
	echo "usage: game-install.sh --nginx [nginx-sites-dir] --content-root [server-root] --self http://myself.com --tracker http://tracker.com --service [dir]"
	exit 1
fi

while [ "x$1" != x ] ; do
	case "x$1" in
		x--nginx)
			shift
			NGINX="$1"
			;;

		x--content-root)
			shift
			WEBROOT="$1"
			;;

		x--self)
			shift
			SELF="$1"
			;;

		x--tracker)
			shift
			TRACKER="$1"
			;;

		x--service)
			shift
			SERVICE="$1"
			;;

		*)
			echo "Unknown argument $1"
			exit 1
			;;
	esac
	shift
done

if [ "x$TRACKER" = x ] ; then
	echo "no --tracker specified"
	exit 1
fi

if [ "x$SELF" = x ] ; then
	echo "no --self specified"
	exit 1
fi

mkdir -p "${WEBROOT}"
mkdir -p "${NGINX}"
mkdir -p "${SERVICE}"

TRACKER_WS="$(echo "${TRACKER}" | sed -e 's/^http/^ws/g')"

sed -e "s@/app@${WEBROOT}@g" -e "s!http://localhost:3001!${TRACKER}!g" -e "s!ws://localhost:3001!${TRACKER_WS}!g" < ./nginx/game.conf > "${NGINX}/game.conf"

# Install beacon service if we're on a systemd system
if [ -d /etc/systemd/system ] ; then
	sed -e "s@/app@${SERVICE}@g" -e "s!@TRACKER@!${TRACKER}!g" -e "s!@SELF@!${SELF}!g" < ./beacon.service > /etc/systemd/system/beacon.service
fi

cp -r dist "${WEBROOT}"
cp -r public "${WEBROOT}"
cp -r clsp "${WEBROOT}"

# Install beacon
cp -r beacon.sh "${SERVICE}"

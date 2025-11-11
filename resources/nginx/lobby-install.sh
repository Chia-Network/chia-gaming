#!/bin/sh

NGINX=/etc/nginx/sites-available
WEBROOT=/usr/share/nginx/html/chia-gaming-lobby
SERVICE=""
TRACKER=""

if [ "x$UID" != "x0" ] ; then
	echo "Run this install script as root"
	exit 1
fi

if [ "x$@" = x ] ; then
	echo "usage: lobby-install.sh --nginx [nginx-sites-dir] --content-root [server-root] --service [dir]"
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

mkdir -p "${WEBROOT}"
mkdir -p "${NGINX}"
mkdir -p "${SERVICE}"

# Install service if we're on a systemd system
if [ -d /etc/systemd/system ] ; then
	sed -e "s@/app@${SERVICE}@g" < ./nginx/lobby.service > /etc/systemd/system
fi

cp -r "${TARGET}/chia-gaming-lobby/dist" "${WEBROOT}"
cp -r "${TARGET}/chia-gaming-lobby/public" "${WEBROOT}"

cp -r "${TARGET}/chia-gaming-lobby/dist/service.js" "${SERVICE}"

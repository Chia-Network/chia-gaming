#!/bin/sh

NGINX=/etc/nginx/sites-available
WEBROOT=/usr/share/nginx/html/lobby-view
SELF_URL=""
SERVICE=""

if [ "x$1" = x ] ; then
	echo "usage: lobby-install.sh --nginx [nginx-sites-dir] --content-root [server-root] --service [dir] --self-url [url]"
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

		x--service)
			shift
			SERVICE="$1"
			;;

		x--self-url)
			shift
			SELF_URL="$1"
			;;

		*)
			echo "Unknown argument $1"
			exit 1
			;;
	esac
	shift
done

if [ "x$SERVICE" = x ] ; then
	echo "no --service dir specified"
	exit 1
fi
if [ "x$SELF_URL" = x ] ; then
	echo "no --self-url provided"
	exit 1
fi

mkdir -p "${WEBROOT}"
mkdir -p "${NGINX}"
mkdir -p "${SERVICE}"

# Install service if we're on a systemd system
if [ -d /etc/systemd/system ] ; then
	sed -e "s@/app@${SERVICE}@g" -e "s!@SELF_URL@!${SELF_URL}!g" < ./lobby.service > /etc/systemd/system/lobby.service
fi

sed -e "s!/app!${WEBROOT}!g" < nginx/lobby.conf > "${NGINX}/lobby.conf"
cp -r public "${WEBROOT}/lobby-view"
cp service.js "${SERVICE}"

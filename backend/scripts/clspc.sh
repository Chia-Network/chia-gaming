#!/bin/sh

THISDIR=$(dirname "$0")
exec node "${THISDIR}/../build/index.js" compile "${@}"

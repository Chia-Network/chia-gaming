#!/bin/sh

THISDIR=$(dirname "$0")
exec node "${THISDIR}/../cli/index.js" "${@}"

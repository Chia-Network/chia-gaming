#!/bin/sh

set -e

REPO="$1"
BRANCH="$2"

if [ ! -d clvm_tools_rs ] ; then
    git clone --depth=1 "${REPO}" -b "${BRANCH}"
fi

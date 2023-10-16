#!/bin/sh

THISDIR=$(dirname "$0")

run_with_messages() {
    COMMAND=$1
    SUCCESS_MSG=$2
    FAIL_MSG=$3

    echo "running ${COMMAND}"
    echo ""

    if sh -c "${COMMAND}" ; then
        echo ""
        echo "${SUCCESS_MSG}"
        echo ""
    else
        echo ""
        echo "${FAIL_MSG}"
        echo ""
        exit 1
    fi
}

run_with_messages \
    "${THISDIR}/clone-or-update.sh https://github.com/Chia-Network/clvm_tools_rs.git staging" \
    "git clone succeeded" \
    "git clone failed"

run_with_messages \
    "cargo install --version=0.2.80 wasm-bindgen-cli" \
    "installed wasm-bindgen-cli@0.2.80" \
    "failed to install wasm-bindgen"

run_with_messages \
    "cargo install --version=0.8.0 wasm-pack" \
    "installed wasm-pack@0.8.0" \
    "failed to install wasm-pack"

run_with_messages \
    "cd clvm_tools_rs/wasm && wasm-pack build --release --target=nodejs" \
    "built clvm_tools_rs wasm code" \
    "failed to build clvm_tools_rs wasm code"

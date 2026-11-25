# shellcheck shell=bash
# Source this file, then call configure_wasm_toolchain before building the
# wasm32 target (wasm-pack or cargo).
#
# C dependencies such as blst are compiled to WebAssembly objects and archived
# into static libraries. The archive needs an index the WebAssembly linker can
# read, which only an LLVM archiver writes: macOS `ar` (and GNU `ar`) produce an
# archive without one, and the final link then fails with undefined `blst_*`
# symbols. cc-rs uses `llvm-ar` only when it is on PATH, and Homebrew's LLVM is
# keg-only, so on macOS it is usually not.
#
# configure_wasm_toolchain exports AR_wasm32_unknown_unknown (and, when the
# ambient clang cannot target wasm32, CC_wasm32_unknown_unknown) from an LLVM
# toolchain. Values the caller already set are kept.

wasm_toolchain_clang_targets_wasm32() {
    local targets
    targets="$("$1" --print-targets 2>/dev/null)" || return 1
    grep -Eq '^[[:space:]]*wasm32[[:space:]]' <<<"$targets"
}

# Print candidate LLVM bin directories, most preferred first.
wasm_toolchain_llvm_bin_dirs() {
    local ambient_clang
    ambient_clang="$(command -v clang 2>/dev/null || true)"
    if [ -n "$ambient_clang" ]; then
        dirname "$ambient_clang"
    fi
    if command -v brew >/dev/null 2>&1; then
        local prefix
        prefix="$(brew --prefix llvm 2>/dev/null || true)"
        if [ -n "$prefix" ]; then
            echo "$prefix/bin"
        fi
    fi
    echo /opt/homebrew/opt/llvm/bin
    echo /usr/local/opt/llvm/bin
}

# Print the path of an LLVM archiver, or nothing.
find_wasm_llvm_ar() {
    if [ -n "${AR_wasm32_unknown_unknown:-}" ]; then
        echo "$AR_wasm32_unknown_unknown"
        return 0
    fi
    local dir
    while IFS= read -r dir; do
        if [ -x "$dir/llvm-ar" ]; then
            echo "$dir/llvm-ar"
            return 0
        fi
    done < <(wasm_toolchain_llvm_bin_dirs)
    command -v llvm-ar 2>/dev/null || true
}

configure_wasm_toolchain() {
    local llvm_ar
    llvm_ar="$(find_wasm_llvm_ar)"
    if [ -z "$llvm_ar" ]; then
        if [ "$(uname -s)" = "Darwin" ]; then
            echo "error: no LLVM archiver (llvm-ar) found for the wasm32 build." >&2
            echo "  macOS ar cannot index WebAssembly objects, so linking fails with" >&2
            echo "  undefined blst_* symbols. Install LLVM with:" >&2
            echo "    tools/check-build-deps.sh --install" >&2
            echo "  or set AR_wasm32_unknown_unknown to an llvm-ar." >&2
            return 1
        fi
        # Elsewhere cc-rs may still find a suitable archiver; let it try.
        return 0
    fi
    export AR_wasm32_unknown_unknown="$llvm_ar"

    if [ -z "${CC_wasm32_unknown_unknown:-}" ]; then
        local ambient_clang llvm_clang
        ambient_clang="$(command -v clang 2>/dev/null || true)"
        llvm_clang="$(dirname "$llvm_ar")/clang"
        if { [ -z "$ambient_clang" ] || ! wasm_toolchain_clang_targets_wasm32 "$ambient_clang"; } &&
            [ -x "$llvm_clang" ] && wasm_toolchain_clang_targets_wasm32 "$llvm_clang"; then
            export CC_wasm32_unknown_unknown="$llvm_clang"
        fi
    fi
}

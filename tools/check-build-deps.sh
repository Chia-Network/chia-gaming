#!/usr/bin/env bash
set -euo pipefail

INSTALL=0
YES=0
MISSING=()
NEEDS_WASM_TARGET=0

APT_UPDATED=0
DNF_UPDATED=0

usage() {
    cat <<'EOF'
Usage: tools/check-build-deps.sh [--install] [--yes]

Checks for build dependencies used by this repository.

Options:
  --install, -i   Attempt to install missing dependencies
  --yes, -y       Non-interactive mode (assume yes when prompting)
  --help, -h      Show this help message

Examples:
  tools/check-build-deps.sh
  tools/check-build-deps.sh --install
  tools/check-build-deps.sh --install --yes
EOF
}

for arg in "$@"; do
    case "$arg" in
    --install|-i) INSTALL=1 ;;
    --yes|-y) YES=1 ;;
    --help|-h)
        usage
        exit 0
        ;;
    *)
        echo "Unknown argument: $arg"
        usage
        exit 2
        ;;
    esac
done

need_cmd() {
    command -v "$1" >/dev/null 2>&1
}

add_missing() {
    MISSING+=("$1")
}

have_missing() {
    [ "${#MISSING[@]}" -gt 0 ]
}

detect_pkg_manager() {
    if need_cmd brew; then
        echo "brew"
    elif need_cmd apt-get; then
        echo "apt"
    elif need_cmd dnf; then
        echo "dnf"
    elif need_cmd yum; then
        echo "yum"
    elif need_cmd pacman; then
        echo "pacman"
    else
        echo "none"
    fi
}

PM="$(detect_pkg_manager)"
SUDO=""
if [ "${EUID:-$(id -u)}" -ne 0 ] && need_cmd sudo; then
    SUDO="sudo"
fi

pm_install() {
    # shellcheck disable=SC2086
    case "$PM" in
    brew)
        brew install "$@"
        ;;
    apt)
        if [ "$APT_UPDATED" -eq 0 ]; then
            $SUDO apt-get update -y
            APT_UPDATED=1
        fi
        $SUDO apt-get install -y "$@"
        ;;
    dnf)
        if [ "$DNF_UPDATED" -eq 0 ]; then
            $SUDO dnf makecache -y
            DNF_UPDATED=1
        fi
        $SUDO dnf install -y "$@"
        ;;
    yum)
        $SUDO yum install -y "$@"
        ;;
    pacman)
        $SUDO pacman -Sy --noconfirm "$@"
        ;;
    *)
        return 1
        ;;
    esac
}

install_rustup() {
    if need_cmd rustup; then
        return 0
    fi

    case "$PM" in
    brew)
        pm_install rustup-init || true
        ;;
    apt|dnf|yum|pacman)
        pm_install rustup || true
        ;;
    esac

    if ! need_cmd rustup; then
        if need_cmd curl; then
            curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
            export PATH="$HOME/.cargo/bin:$PATH"
        else
            return 1
        fi
    fi

    need_cmd rustup
}

install_uv() {
    if need_cmd uv; then
        return 0
    fi

    case "$PM" in
    brew|apt|dnf|yum|pacman)
        pm_install uv || true
        ;;
    esac

    if ! need_cmd uv; then
        if need_cmd curl; then
            curl -LsSf https://astral.sh/uv/install.sh | sh
            export PATH="$HOME/.local/bin:$PATH"
        else
            return 1
        fi
    fi

    need_cmd uv
}

install_corepack() {
    if need_cmd corepack; then
        return 0
    fi

    if need_cmd npm; then
        npm install -g corepack
    else
        return 1
    fi
}

install_yarn() {
    if need_cmd yarn; then
        return 0
    fi

    if ! need_cmd corepack; then
        install_corepack || return 1
    fi

    corepack enable
    corepack prepare yarn@stable --activate
    need_cmd yarn
}

check_python_version() {
    if ! need_cmd python3; then
        return 1
    fi

    python3 - <<'PY'
import sys
sys.exit(0 if sys.version_info >= (3, 9) else 1)
PY
}

check_deps() {
    MISSING=()
    NEEDS_WASM_TARGET=0

    need_cmd git || add_missing git
    need_cmd curl || add_missing curl
    need_cmd clang || add_missing clang
    need_cmd pkg-config || add_missing pkg-config
    need_cmd make || add_missing make
    need_cmd python3 || add_missing python3
    need_cmd pip3 || add_missing pip3
    need_cmd uv || add_missing uv
    need_cmd node || add_missing node
    need_cmd npm || add_missing npm
    need_cmd corepack || add_missing corepack
    need_cmd yarn || add_missing yarn
    need_cmd rustup || add_missing rustup
    need_cmd rustc || add_missing rustc
    need_cmd cargo || add_missing cargo
    need_cmd wasm-pack || add_missing wasm-pack

    if ! check_python_version; then
        add_missing python3.9+
    fi

    if need_cmd rustup; then
        if ! rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
            NEEDS_WASM_TARGET=1
        fi
    fi
}

print_missing() {
    if ! have_missing && [ "$NEEDS_WASM_TARGET" -eq 0 ]; then
        echo "All build dependencies are installed."
        return
    fi

    echo "Missing build dependencies:"
    for dep in "${MISSING[@]}"; do
        echo "  - $dep"
    done
    if [ "$NEEDS_WASM_TARGET" -eq 1 ]; then
        echo "  - rust target: wasm32-unknown-unknown"
    fi
}

install_dep() {
    dep="$1"
    case "$dep" in
    git|curl|pkg-config|make|clang)
        case "$PM" in
        brew)
            if [ "$dep" = "pkg-config" ]; then
                pm_install pkg-config
            elif [ "$dep" = "make" ]; then
                pm_install make
            elif [ "$dep" = "clang" ]; then
                if need_cmd xcode-select; then
                    xcode-select --install || true
                else
                    pm_install llvm
                fi
            else
                pm_install "$dep"
            fi
            ;;
        apt)
            if [ "$dep" = "pkg-config" ]; then
                pm_install pkg-config
            elif [ "$dep" = "make" ]; then
                pm_install build-essential
            elif [ "$dep" = "clang" ]; then
                pm_install clang build-essential
            else
                pm_install "$dep"
            fi
            ;;
        dnf|yum)
            if [ "$dep" = "pkg-config" ]; then
                pm_install pkgconf-pkg-config
            elif [ "$dep" = "make" ]; then
                pm_install make gcc gcc-c++
            elif [ "$dep" = "clang" ]; then
                pm_install clang gcc gcc-c++
            else
                pm_install "$dep"
            fi
            ;;
        pacman)
            if [ "$dep" = "pkg-config" ]; then
                pm_install pkgconf
            elif [ "$dep" = "make" ]; then
                pm_install base-devel
            elif [ "$dep" = "clang" ]; then
                pm_install clang base-devel
            else
                pm_install "$dep"
            fi
            ;;
        *)
            return 1
            ;;
        esac
        ;;
    python3|pip3|python3.9+)
        case "$PM" in
        brew)
            pm_install python
            ;;
        apt)
            pm_install python3 python3-pip python3-venv
            ;;
        dnf|yum)
            pm_install python3 python3-pip
            ;;
        pacman)
            pm_install python python-pip
            ;;
        *)
            return 1
            ;;
        esac
        ;;
    uv)
        install_uv
        ;;
    node|npm)
        case "$PM" in
        brew)
            pm_install node
            ;;
        apt)
            pm_install nodejs npm
            ;;
        dnf|yum)
            pm_install nodejs npm
            ;;
        pacman)
            pm_install nodejs npm
            ;;
        *)
            return 1
            ;;
        esac
        ;;
    corepack)
        install_corepack
        ;;
    yarn)
        install_yarn
        ;;
    rustup|rustc|cargo)
        install_rustup
        ;;
    wasm-pack)
        if ! need_cmd cargo; then
            install_rustup || return 1
        fi
        cargo install wasm-pack --locked
        ;;
    *)
        return 1
        ;;
    esac
}

check_deps
print_missing

if ! have_missing && [ "$NEEDS_WASM_TARGET" -eq 0 ]; then
    exit 0
fi

if [ "$INSTALL" -ne 1 ]; then
    echo
    echo "Run with --install to install missing dependencies."
    exit 1
fi

if [ "$YES" -ne 1 ]; then
    printf "Install missing dependencies now? [y/N] "
    read -r reply
    case "${reply:-}" in
    y|Y|yes|YES) ;;
    *)
        echo "Aborted."
        exit 1
        ;;
    esac
fi

echo
echo "Installing missing dependencies..."
for dep in "${MISSING[@]}"; do
    echo "-> $dep"
    if ! install_dep "$dep"; then
        echo "Could not automatically install: $dep"
    fi
done

if [ "$NEEDS_WASM_TARGET" -eq 1 ]; then
    if need_cmd rustup; then
        echo "-> rust target wasm32-unknown-unknown"
        rustup target add wasm32-unknown-unknown
    else
        echo "Could not add wasm target because rustup is unavailable."
    fi
fi

echo
echo "Re-checking dependencies..."
check_deps
print_missing

if ! have_missing && [ "$NEEDS_WASM_TARGET" -eq 0 ]; then
    echo "Build dependencies are ready."
    exit 0
fi

echo "Some dependencies are still missing. Please install them manually."
exit 1

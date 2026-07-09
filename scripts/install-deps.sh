#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ────────────────────────────────────────────────────────────────
readonly kDoxybook2Version="v1.6.3"
readonly kDoxybook2BaseUrl="https://github.com/GeniusVentures/doxybook2/releases/download/${kDoxybook2Version}"
readonly kInstallDir="/usr/local/bin"

readonly kColorReset='\033[0m'
readonly kColorGreen='\033[0;32m'
readonly kColorYellow='\033[1;33m'
readonly kColorRed='\033[0;31m'
readonly kColorCyan='\033[0;36m'

# ── OS detection ────────────────────────────────────────────────────────────────
detect_platform() {
    local os
    local arch
    os=$(uname -s)
    arch=$(uname -m)

    case "$os" in
        Linux)
            echo "linux-amd64"
            ;;
        Darwin)
            echo "osx-universal"
            ;;
        *)
            echo "Error: unsupported operating system: $os" >&2
            echo "       Supported: Linux (amd64), macOS (universal x86_64 + arm64)" >&2
            exit 1
            ;;
    esac
}

# ── Prerequisite checks ─────────────────────────────────────────────────────────
check_prereqs() {
    if ! command -v curl &>/dev/null; then
        echo "Error: curl not found — required to download binaries." >&2
        echo "       Install with: apt-get install curl (Linux) or brew install curl (macOS)" >&2
        exit 1
    fi

    if ! command -v unzip &>/dev/null; then
        echo "Error: unzip not found — required to extract binaries." >&2
        echo "       Install with: apt-get install unzip (Linux) or brew install unzip (macOS)" >&2
        exit 1
    fi
}

# ── Install doxybook2 ───────────────────────────────────────────────────────────
install_doxybook2() {
    local platform="$1"
    local zip_name="doxybook2-${platform}-${kDoxybook2Version}.zip"
    local download_url="${kDoxybook2BaseUrl}/${zip_name}"
    local tmp_dir
    tmp_dir=$(mktemp -d)
    local zip_path="${tmp_dir}/${zip_name}"

    echo ""
    echo "  Platform:       ${platform}"
    echo "  Download URL:   ${download_url}"
    echo "  Install dir:    ${kInstallDir}"
    echo ""

    # ── Download ──────────────────────────────────────────────────────────────
    echo "  Downloading ${zip_name}..."
    if ! curl -fSL --progress-bar -o "${zip_path}" "${download_url}"; then
        echo "Error: failed to download ${download_url}" >&2
        rm -rf "${tmp_dir}"
        exit 1
    fi
    echo "  Download complete (${tmp_dir}/${zip_name})"

    # ── Extract ───────────────────────────────────────────────────────────────
    echo "  Extracting..."
    if ! unzip -o "${zip_path}" -d "${tmp_dir}" >/dev/null; then
        echo "Error: failed to unzip ${zip_path}" >&2
        rm -rf "${tmp_dir}"
        exit 1
    fi

    # ── Find the binary in the extracted contents ────────────────────────────
    local binary_path
    binary_path=$(find "${tmp_dir}" -type f -name "doxybook2" -perm +111 2>/dev/null | head -1)
    if [ -z "${binary_path}" ]; then
        # Fallback: look for doxybook2 anywhere in the extracted tree
        binary_path=$(find "${tmp_dir}" -type f -name "doxybook2" 2>/dev/null | head -1)
        if [ -z "${binary_path}" ]; then
            echo "Error: doxybook2 binary not found in extracted archive" >&2
            echo "       Contents of ${tmp_dir}:" >&2
            find "${tmp_dir}" -type f >&2
            rm -rf "${tmp_dir}"
            exit 1
        fi
    fi
    echo "  Found binary:   ${binary_path}"

    # ── Install ──────────────────────────────────────────────────────────────
    local install_path="${kInstallDir}/doxybook2"
    if [ -w "${kInstallDir}" ]; then
        cp "${binary_path}" "${install_path}"
        chmod +x "${install_path}"
    else
        echo "  (sudo required for ${kInstallDir})"
        sudo cp "${binary_path}" "${install_path}"
        sudo chmod +x "${install_path}"
    fi

    # ── Verify ───────────────────────────────────────────────────────────────
    if ! command -v doxybook2 &>/dev/null; then
        echo "Error: doxybook2 installed to ${install_path} but not on PATH" >&2
        echo "       Add ${kInstallDir} to your PATH or move the binary." >&2
        rm -rf "${tmp_dir}"
        exit 1
    fi

    echo "  Installed:      ${install_path}"
    echo "  Version:        $(doxybook2 --version 2>&1 || echo 'unknown')"

    # ── Cleanup ──────────────────────────────────────────────────────────────
    rm -rf "${tmp_dir}"
}

# ── Main ────────────────────────────────────────────────────────────────────────
main() {
    echo ""
    echo "=============================================="
    echo "  install_deps — GeniusVentures doxybook2"
    echo "  Version: ${kDoxybook2Version}"
    echo "=============================================="

    check_prereqs

    local platform
    platform=$(detect_platform)

    if command -v doxybook2 &>/dev/null; then
        local existing_version
        existing_version=$(doxybook2 --version 2>&1 || echo "unknown")
        echo ""
        echo "  doxybook2 is already installed:"
        echo "  Path:    $(command -v doxybook2)"
        echo "  Version: ${existing_version}"
        echo ""
        echo "  To reinstall with ${kDoxybook2Version}, remove it first:"
        echo "    rm $(command -v doxybook2)"
        echo "  Then re-run this script."
        exit 0
    fi

    if [ ! -f "$(command -v doxybook2 2>/dev/null || echo /nonexistent)" ]; then
        install_doxybook2 "${platform}"
    fi

    echo ""
    echo "=============================================="
    echo "  install_deps complete"
    echo "  doxybook2 ${kDoxybook2Version} installed to ${kInstallDir}"
    echo "=============================================="
}

main

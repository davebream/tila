#!/bin/sh
# Install script for tila CLI
# Usage: curl -fsSL https://github.com/davebream/tila/releases/latest/download/install.sh | sh
set -eu

INSTALL_DIR="${HOME}/.tila/bin"
BINARY_NAME="tila"
GITHUB_REPO="davebream/tila"
BASE_URL="https://github.com/${GITHUB_REPO}/releases/download"

# --- Platform detection ---
detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "${OS}" in
    Linux|linux)   PLATFORM_OS="linux" ;;
    Darwin|darwin) PLATFORM_OS="darwin" ;;
    *)
      echo "ERROR: Unsupported operating system: ${OS}" >&2
      echo "Download manually from https://github.com/${GITHUB_REPO}/releases or use: npm install -g tila-cli" >&2
      exit 1
      ;;
  esac

  case "${ARCH}" in
    x86_64|amd64)       PLATFORM_ARCH="x64" ;;
    aarch64|arm64)      PLATFORM_ARCH="arm64" ;;
    *)
      echo "ERROR: Unsupported architecture: ${ARCH}" >&2
      echo "Download manually from https://github.com/${GITHUB_REPO}/releases or use: npm install -g tila-cli" >&2
      exit 1
      ;;
  esac

  BINARY_FILENAME="tila-${PLATFORM_OS}-${PLATFORM_ARCH}"
}

# --- Version resolution ---
resolve_version() {
  if [ -n "${TILA_VERSION:-}" ]; then
    RELEASE_TAG="${TILA_VERSION}"
    return
  fi

  RELEASE_TAG=$(curl -fsSL "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" 2>/dev/null \
    | grep '"tag_name"' \
    | sed 's/.*"tag_name": "\(.*\)".*/\1/')

  if [ -z "${RELEASE_TAG}" ]; then
    echo "ERROR: Failed to resolve latest release version from GitHub API." >&2
    echo "This may be due to rate limiting. Set TILA_VERSION=v0.1.0 and re-run." >&2
    exit 1
  fi
}

# --- Upgrade check ---
check_existing() {
  if [ -x "${INSTALL_DIR}/${BINARY_NAME}" ]; then
    INSTALLED_VERSION=$("${INSTALL_DIR}/${BINARY_NAME}" --version 2>/dev/null || echo "unknown")
    if [ "${INSTALLED_VERSION}" = "${RELEASE_TAG#v}" ] || [ "v${INSTALLED_VERSION}" = "${RELEASE_TAG}" ]; then
      echo "Already at ${RELEASE_TAG}. Reinstalling."
    else
      echo "Upgrading ${INSTALLED_VERSION} -> ${RELEASE_TAG}."
    fi
  fi
}

# --- Download and verify ---
download_and_verify() {
  TMP_DIR=$(mktemp -d)
  trap 'rm -rf "${TMP_DIR}"' EXIT

  BINARY_URL="${BASE_URL}/${RELEASE_TAG}/${BINARY_FILENAME}"
  CHECKSUM_URL="${BASE_URL}/${RELEASE_TAG}/checksums.txt"

  echo "Downloading ${BINARY_FILENAME} (${RELEASE_TAG})..."
  if ! curl -fsSL -o "${TMP_DIR}/${BINARY_FILENAME}" "${BINARY_URL}"; then
    echo "ERROR: Failed to download binary from: ${BINARY_URL}" >&2
    exit 1
  fi

  echo "Downloading checksums..."
  if ! curl -fsSL -o "${TMP_DIR}/checksums.txt" "${CHECKSUM_URL}"; then
    echo "ERROR: Failed to download checksums from: ${CHECKSUM_URL}" >&2
    exit 1
  fi

  echo "Verifying SHA-256 checksum..."
  EXPECTED_HASH=$(grep "${BINARY_FILENAME}$" "${TMP_DIR}/checksums.txt" | awk '{print $1}')
  if [ -z "${EXPECTED_HASH}" ]; then
    echo "ERROR: Binary ${BINARY_FILENAME} not found in checksums.txt" >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL_HASH=$(sha256sum "${TMP_DIR}/${BINARY_FILENAME}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    ACTUAL_HASH=$(shasum -a 256 "${TMP_DIR}/${BINARY_FILENAME}" | awk '{print $1}')
  else
    echo "WARNING: Neither sha256sum nor shasum found. Skipping checksum verification." >&2
    ACTUAL_HASH="${EXPECTED_HASH}"
  fi

  if [ "${ACTUAL_HASH}" != "${EXPECTED_HASH}" ]; then
    echo "ERROR: SHA-256 checksum mismatch for ${BINARY_FILENAME}." >&2
    echo "  Expected: ${EXPECTED_HASH}" >&2
    echo "  Actual:   ${ACTUAL_HASH}" >&2
    echo "Download may be corrupt or tampered. Aborting." >&2
    exit 1
  fi
  echo "Checksum verified."
}

# --- Install ---
install_binary() {
  mkdir -p "${INSTALL_DIR}"
  chmod +x "${TMP_DIR}/${BINARY_FILENAME}"

  # Atomic install: write to install dir temp file, then mv (same filesystem)
  cp "${TMP_DIR}/${BINARY_FILENAME}" "${INSTALL_DIR}/${BINARY_NAME}.tmp"
  mv "${INSTALL_DIR}/${BINARY_NAME}.tmp" "${INSTALL_DIR}/${BINARY_NAME}"

  echo "Installed to ${INSTALL_DIR}/${BINARY_NAME}"
}

# --- PATH update ---
update_path() {
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) return ;;
  esac

  SHELL_LINE="export PATH=\"\$HOME/.tila/bin:\$PATH\""

  if [ -f "${HOME}/.bashrc" ]; then
    if ! grep -qF '.tila/bin' "${HOME}/.bashrc" 2>/dev/null; then
      printf '\n# tila CLI\n%s\n' "${SHELL_LINE}" >> "${HOME}/.bashrc"
    fi
  fi

  if [ -f "${HOME}/.zshrc" ]; then
    if ! grep -qF '.tila/bin' "${HOME}/.zshrc" 2>/dev/null; then
      printf '\n# tila CLI\n%s\n' "${SHELL_LINE}" >> "${HOME}/.zshrc"
    fi
  fi

  echo ""
  echo "Added ${INSTALL_DIR} to PATH in shell config."
  echo "Run 'source ~/.bashrc' or 'source ~/.zshrc' (or restart your terminal) to use tila."
}

# --- Unsigned binary notice ---
unsigned_notice() {
  if [ "${PLATFORM_OS}" = "darwin" ]; then
    echo ""
    echo "NOTE: macOS may block the unsigned binary. If you see a Gatekeeper warning, run:"
    echo "  xattr -d com.apple.quarantine ${INSTALL_DIR}/${BINARY_NAME}"
  fi
}

# --- Main ---
main() {
  echo "tila installer"
  echo ""

  detect_platform
  resolve_version
  check_existing
  download_and_verify
  install_binary
  update_path
  unsigned_notice

  echo ""
  VERSION_OUTPUT=$("${INSTALL_DIR}/${BINARY_NAME}" --version 2>/dev/null || echo "run failed")
  echo "tila ${VERSION_OUTPUT} installed successfully."
}

main

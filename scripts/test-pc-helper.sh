#!/usr/bin/env bash
# Builds and runs the BruceControl Swift test harness (native/macos/tests) in a temp directory.
# The harness compiles every helper source except main.swift and MenuBar.swift. It never launches BruceControl.app,
# never posts input events and never touches the real Keychain or ~/.bruce-comm. Exit code: 0 = all tests passed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/macos/BruceControl"
TESTS="$ROOT/native/macos/tests"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "test-pc-helper: macOS only." >&2
  exit 1
fi
SWIFTC="${SWIFTC:-swiftc}"
if ! command -v "$SWIFTC" >/dev/null 2>&1; then
  echo "test-pc-helper: swiftc not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
ARCH="$(uname -m)"

TMPBASE="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMPBASE%/}/brucecontrol-tests.XXXXXX")"
# Short root for the test sockets (unix socket paths are limited to 104 bytes); removed even if the harness crashes.
TROOT="$(mktemp -d /tmp/bct.XXXXXX)"
export BRUCE_CONTROL_TEST_TMP="$TROOT"
trap 'rm -rf "$WORK" "$TROOT"' EXIT

SOURCES=()
for f in "$SRC"/*.swift; do
  case "$(basename "$f")" in
    main.swift | MenuBar.swift) ;;
    *) SOURCES+=("$f") ;;
  esac
done
for f in "$TESTS"/*.swift; do SOURCES+=("$f"); done

echo "Compiling the BruceControl test harness (${#SOURCES[@]} files)..."
SDK_ARGS=()
if [[ -n "$SDK" ]]; then SDK_ARGS=(-sdk "$SDK"); fi
"$SWIFTC" -Onone -g -swift-version 5 -target "$ARCH-apple-macos14.0" ${SDK_ARGS[@]+"${SDK_ARGS[@]}"} \
  -module-name BruceControlTests \
  -framework AppKit -framework ScreenCaptureKit -framework LocalAuthentication -framework Carbon \
  -framework ApplicationServices -framework CoreGraphics -framework ImageIO -framework Security \
  -lsqlite3 \
  -o "$WORK/bruce-control-tests" \
  "${SOURCES[@]}"

# Helper log lines (stderr) go to a file; shown only when something fails.
set +e
"$WORK/bruce-control-tests" 2>"$WORK/helper.log"
status=$?
set -e
if [[ $status -ne 0 ]]; then
  echo
  echo "Helper log (last 60 lines):"
  tail -n 60 "$WORK/helper.log" || true
  echo "test-pc-helper: FAILED (exit $status)" >&2
  exit 1
fi
echo "test-pc-helper: all tests passed"

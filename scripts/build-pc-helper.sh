#!/usr/bin/env bash
# Builds the Bruce Control PC-control helper (BruceControl.app) from source and ad-hoc signs it (hardened runtime).
# Output: ${BRUCE_PC_HELPER_APP:-$HOME/Applications/BruceControl.app}
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/native/macos/BruceControl"
OUT="${BRUCE_PC_HELPER_APP:-$HOME/Applications/BruceControl.app}"
BUNDLE_ID="com.bruce.comm.pccontrol"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-pc-helper: macOS only." >&2
  exit 1
fi
case "$OUT" in
  /*.app) ;;
  *) echo "build-pc-helper: BRUCE_PC_HELPER_APP must be an absolute path ending in .app (got: $OUT)" >&2; exit 1 ;;
esac
# Never replace a bundle that is not ours.
if [[ -e "$OUT" ]]; then
  existing_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$OUT/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing_id" != "$BUNDLE_ID" ]]; then
    echo "build-pc-helper: $OUT exists but is not $BUNDLE_ID; refusing to replace it." >&2
    exit 1
  fi
fi

SWIFTC="${SWIFTC:-swiftc}"
if ! command -v "$SWIFTC" >/dev/null 2>&1; then
  echo "build-pc-helper: swiftc not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
ARCH="$(uname -m)"

TMPBASE="${TMPDIR:-/tmp}"
STAGE="$(mktemp -d "${TMPBASE%/}/brucecontrol-build.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/BruceControl.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

shopt -s nullglob
SOURCES=("$SRC"/*.swift)
shopt -u nullglob
if [[ ${#SOURCES[@]} -eq 0 ]]; then
  echo "build-pc-helper: no Swift sources in $SRC" >&2
  exit 1
fi

echo "Compiling Bruce Control (${#SOURCES[@]} files, $ARCH, macOS 14+)..."
SDK_ARGS=()
if [[ -n "$SDK" ]]; then SDK_ARGS=(-sdk "$SDK"); fi
"$SWIFTC" -O -swift-version 5 -target "$ARCH-apple-macos14.0" ${SDK_ARGS[@]+"${SDK_ARGS[@]}"} \
  -module-name BruceControl \
  -framework AppKit -framework ScreenCaptureKit -framework LocalAuthentication -framework Carbon \
  -framework ApplicationServices -framework CoreGraphics -framework ImageIO -framework Security \
  -lsqlite3 \
  -o "$APP/Contents/MacOS/BruceControl" \
  "${SOURCES[@]}"

cp "$SRC/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
plutil -lint "$APP/Contents/Info.plist" >/dev/null

# Hardened runtime: no DYLD_* injection or unsigned code in the process that holds Accessibility/Screen Recording.
codesign -o runtime --force --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --strict "$APP"
# Capture first, then match: a pipe into `grep -q` can SIGPIPE codesign and fail spuriously under pipefail.
if ! sig="$(codesign -dv "$APP" 2>&1)"; then
  echo "build-pc-helper: cannot read the signature: $sig" >&2
  exit 1
fi
flags_re='flags=0x[0-9a-fA-F]+\(([^)]*)\)'
if ! [[ "$sig" =~ $flags_re ]] || [[ ",${BASH_REMATCH[1]}," != *",runtime,"* ]]; then
  echo "build-pc-helper: the signature has no hardened-runtime flag" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
rm -rf "$OUT"
mv "$APP" "$OUT"

echo
echo "Built and ad-hoc signed: $OUT"
echo
echo "Permissions the owner must grant (System Settings > Privacy & Security):"
echo "  - Accessibility: add/enable BruceControl ($OUT)"
echo "  - Screen & System Audio Recording: add/enable BruceControl"
echo "  After every rebuild the ad-hoc signature changes: remove and re-add (or re-toggle) BruceControl in both lists."
echo "  After a rebuild the Keychain asks once whether BruceControl may use \"$BUNDLE_ID\" (its grants and stop flag):"
echo "  allow it only when the prompt names BruceControl; deny such a prompt from security, Terminal, node or any other app."
echo "  Bruce Comm starts the helper on demand; the dashboard (http://127.0.0.1:7457/) has a 'Request permissions' button."

if pgrep -x BruceControl >/dev/null 2>&1; then
  echo
  echo "NOTE: a Bruce Control helper is running and still uses the old build."
  echo "      Quit it from the menu bar (Bruce Control > Quit); Bruce Comm relaunches the new one on demand."
fi

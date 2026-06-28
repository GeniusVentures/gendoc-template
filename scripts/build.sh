#!/usr/bin/env bash
set -euo pipefail

# ── Locate template root and host project root ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$HOST_ROOT/gendoc.yml"

# ── Validate prerequisites ────────────────────────────────────────────────────
if [ ! -f "$GENDOC_YML" ]; then
    echo "Error: gendoc.yml not found at $GENDOC_YML" >&2
    echo "       Create one by copying gendoc-template/gendoc.yml.example and filling in your project values." >&2
    exit 1
fi

BUILD_API_REFERENCE_SCRIPT="$TEMPLATE_ROOT/scripts/build_source_reference.sh"
if [ ! -f "$BUILD_API_REFERENCE_SCRIPT" ]; then
    echo "Error: build_source_reference.sh not found at $BUILD_API_REFERENCE_SCRIPT" >&2
    exit 1
fi

MKDOCS_YML="$TEMPLATE_ROOT/mkdocs.yml"
if [ ! -f "$MKDOCS_YML" ]; then
    echo "Error: mkdocs.yml not found at $MKDOCS_YML" >&2
    exit 1
fi

if ! command -v mkdocs &>/dev/null; then
    echo "Error: mkdocs not found." >&2
    echo "       Install with: pip install mkdocs mkdocs-material mkdocs-literate-nav" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found." >&2
    exit 1
fi

# ── Read gendoc.yml values ────────────────────────────────────────────────────
echo "Reading gendoc.yml..."

read_yaml() {
    python3 -c "import yaml, sys
with open(sys.argv[1], 'r') as f:
    cfg = yaml.safe_load(f)
value = cfg
for key in sys.argv[2].split('.'):
    if isinstance(value, dict) and key in value:
        value = value[key]
    elif isinstance(value, list):
        try:
            idx = int(key)
            value = value[idx]
        except (ValueError, IndexError):
            print('', end='')
            sys.exit(0)
    else:
        print('', end='')
        sys.exit(0)
if isinstance(value, bool):
    print('true' if value else 'false', end='')
elif isinstance(value, list):
    print(' '.join(str(v) for v in value), end='')
elif value is None:
    print('', end='')
else:
    print(str(value), end='')
" "$GENDOC_YML" "$1"
}

SITE_DIR=$(read_yaml "mkdocs.site_dir")
STRICT_RAW=$(read_yaml "mkdocs.strict")

# ── Defaults ──────────────────────────────────────────────────────────────────
if [ -z "$SITE_DIR" ]; then
    SITE_DIR="site"
fi

if [ "$STRICT_RAW" = "true" ]; then
    STRICT_FLAG="--strict"
else
    STRICT_FLAG=""
fi

# ── Step 1: Build API reference (Doxygen → doxybook2 → navigation) ───────────
echo ""
echo "=============================================="
echo "  Step 1: Building API reference"
echo "=============================================="

if bash "$BUILD_API_REFERENCE_SCRIPT"; then
    echo "  API reference build completed successfully"
else
    exit_code=$?
    echo "Error: build_source_reference.sh failed with exit code $exit_code" >&2
    exit $exit_code
fi

# ── Step 2: Build MkDocs site ─────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Step 2: Building MkDocs site"
echo "=============================================="

SITE_DIR_ABS="$HOST_ROOT/$SITE_DIR"
echo "  Output directory: $SITE_DIR_ABS"

if mkdocs build -f "$MKDOCS_YML" --site-dir "$SITE_DIR" $STRICT_FLAG; then
    echo "  MkDocs build completed successfully"
else
    exit_code=$?
    echo "Error: mkdocs build failed with exit code $exit_code" >&2
    exit $exit_code
fi

# ── Success ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Full build complete"
echo "  Site output: $SITE_DIR_ABS"
echo "=============================================="

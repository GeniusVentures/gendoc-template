#!/usr/bin/env bash
set -euo pipefail

# ── Locate template root and host project root ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$HOST_ROOT/gendoc.yml"

# ── Activate Python virtual environment ────────────────────────────────────────
VENV="$TEMPLATE_ROOT/.venv"
if [ -d "$VENV" ]; then
    export PATH="$VENV/bin:$PATH"
    echo "Using venv: $VENV"
fi

# ── Validate prerequisites ────────────────────────────────────────────────────
if [ ! -f "$GENDOC_YML" ]; then
    echo "Error: gendoc.yml not found at $GENDOC_YML" >&2
    echo "       Create one by copying gendoc-template/gendoc.yml.example and filling in your project values." >&2
    exit 1
fi

BUILD_SOURCE_REFERENCE_SCRIPT="$TEMPLATE_ROOT/scripts/build-source-reference.sh"
if [ ! -f "$BUILD_SOURCE_REFERENCE_SCRIPT" ]; then
    echo "Error: build-source-reference.sh not found at $BUILD_SOURCE_REFERENCE_SCRIPT" >&2
    exit 1
fi

MKDOCS_YML="$TEMPLATE_ROOT/mkdocs.yml"
if [ ! -f "$MKDOCS_YML" ]; then
    echo "Error: mkdocs.yml not found at $MKDOCS_YML" >&2
    exit 1
fi

if ! command -v mkdocs &>/dev/null; then
    echo "Error: mkdocs not found." >&2
    echo "       Create a .venv with: python3 -m venv .venv && source .venv/bin/activate" >&2
    echo "       Then: pip install mkdocs mkdocs-material mkdocs-literate-nav" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found." >&2
    exit 1
fi

# ── Read gendoc.yml values ────────────────────────────────────────────────────
echo "Reading gendoc.yml..."

read_yaml() {
    python3 "$SCRIPT_DIR/read-yaml.py" "$GENDOC_YML" "$1"
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

# ── Step 1: Build source reference (Doxygen → doxybook2 → navigation) ────────
echo ""
echo "=============================================="
echo "  Step 1: Building source reference"
echo "=============================================="

if bash "$BUILD_SOURCE_REFERENCE_SCRIPT"; then
    echo "  Source reference build completed successfully"
else
    exit_code=$?
    echo "Error: build-source-reference.sh failed with exit code $exit_code" >&2
    exit $exit_code
fi

# ── Step 2: Regenerate index.md (from hand-written doc headings) ─────────────
GENERATE_INDEX=$(read_yaml "navigation.generate_index")
HANDWRITTEN_DOCS=$(read_yaml "paths.handwritten_docs")
INDEX_SCRIPT="$SCRIPT_DIR/generate-index.sh"
HANDWRITTEN_DOCS_ABS="$HOST_ROOT/$HANDWRITTEN_DOCS"
echo ""
echo "=============================================="
echo "  Step 2: Regenerating index.md"
echo "=============================================="
if [ "$GENERATE_INDEX" != "true" ]; then
    echo "  Skipped — navigation.generate_index is not true"
elif [ ! -f "$INDEX_SCRIPT" ]; then
    echo "  Skipped — generate-index.sh not found at $INDEX_SCRIPT"
elif [ ! -f "$HANDWRITTEN_DOCS_ABS/index.md.template" ]; then
    echo "  Skipped — index.md.template not found in $HANDWRITTEN_DOCS"
else
    bash "$INDEX_SCRIPT" "$HANDWRITTEN_DOCS_ABS"
    echo "  index.md regenerated from $HANDWRITTEN_DOCS/index.md.template"
fi

# ── Step 3: Build MkDocs site ─────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Step 3: Building MkDocs site"
echo "=============================================="

SITE_DIR_ABS="$TEMPLATE_ROOT/$SITE_DIR"
echo "  Output directory: $SITE_DIR_ABS"

if mkdocs build -f "$MKDOCS_YML" --site-dir "$SITE_DIR_ABS" $STRICT_FLAG; then
    echo "  MkDocs build completed successfully"
else
    exit_code=$?
    echo "Error: mkdocs build failed with exit code $exit_code" >&2
    exit $exit_code
fi

# ── Step 4: Build search vocabulary for the typo-tolerant ask worker ──────────
echo ""
echo "=============================================="
echo "  Step 4:  Building search vocabulary"
echo "=============================================="
VOCAB_BUILDER="$SCRIPT_DIR/build-vocab.py"
SEARCH_INDEX="$SITE_DIR_ABS/search/search_index.json"
VOCAB_OUT="$SITE_DIR_ABS/data/search-vocab.json"

if [ -f "$SEARCH_INDEX" ] && [ -f "$VOCAB_BUILDER" ]; then
    mkdir -p "$(dirname "$VOCAB_OUT")"
    if python3 "$VOCAB_BUILDER" "$SEARCH_INDEX" "$VOCAB_OUT"; then
        echo "  Search vocabulary built: $VOCAB_OUT"
    else
        echo "  WARNING: build-vocab.py failed (ask worker will use raw term matching)"
    fi
else
    echo "  Skipped — search_index.json or build-vocab.py not found"
fi

# ── Step 5: Build ask widget (must run AFTER mkdocs — writes to site dir) ──────
echo ""
echo "=============================================="
echo "  Step 5:  Building ask widget"
echo "=============================================="
"$SCRIPT_DIR/build-widget.sh"

echo ""
echo "=============================================="
echo "  Step 6: Generating llms.txt agent catalogs"
echo "=============================================="
python3 "$SCRIPT_DIR/build-llms.py" "$@"

# ── Success ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Full build complete"
echo "  Site output: $SITE_DIR_ABS"
echo "=============================================="

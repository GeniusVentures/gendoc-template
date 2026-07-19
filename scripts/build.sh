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

if ! command -v properdocs &>/dev/null; then
    echo "Error: properdocs not found." >&2
    echo "       Create a .venv with: python3 -m venv .venv && source .venv/bin/activate" >&2
    echo "       Then: pip install properdocs mkdocs-material mkdocs-literate-nav" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found." >&2
    exit 1
fi

# ── Install gendoc-template plugins into the venv ─────────────────────────────
PLUGINS_DIR="$TEMPLATE_ROOT/plugins"
if [ -f "$PLUGINS_DIR/setup.py" ]; then
    pip install --quiet -e "$PLUGINS_DIR"
fi

# ── Read gendoc.yml values (single Python call, emits shell assignments) ───────
echo "Reading gendoc.yml..."

eval "$(python3 "$SCRIPT_DIR/read-yaml.py" "$GENDOC_YML" --batch \
    "mkdocs.site_dir=SITE_DIR" \
    "mkdocs.strict=STRICT_RAW" \
    "navigation.generate_index=GENERATE_INDEX" \
    "navigation.index_template=INDEX_TEMPLATE" \
    "navigation.index_output=INDEX_OUTPUT" \
    "paths.handwritten_docs=HANDWRITTEN_DOCS" \
    "deploy.cloudflare.gzip_json=GZIP_JSON" \
)"

# ── Defaults ──────────────────────────────────────────────────────────────────
if [ -z "$SITE_DIR" ]; then
    SITE_DIR="site"
fi

if [ "$STRICT_RAW" = "true" ]; then
    STRICT_FLAG="--strict"
else
    STRICT_FLAG=""
fi

# ── Step 1: Regenerate configured navigation index ──────────────────────────────
# Must run BEFORE Step 2 — build-navigation.py reads SUMMARY.md to generate
# SUMMARY_EXT.md for MkDocs, and SUMMARY.md is git-ignored (regenerated fresh).
INDEX_SCRIPT="$SCRIPT_DIR/generate-index.sh"
HANDWRITTEN_DOCS_ABS="$HOST_ROOT/$HANDWRITTEN_DOCS"
INDEX_TEMPLATE="${INDEX_TEMPLATE:-index.md.template}"
INDEX_OUTPUT="${INDEX_OUTPUT:-index.md}"
echo ""
echo "=============================================="
echo "  Step 1: Regenerating $INDEX_OUTPUT"
echo "=============================================="
if [ "$GENERATE_INDEX" != "true" ]; then
    echo "  Skipped — navigation.generate_index is not true"
elif [ ! -f "$INDEX_SCRIPT" ]; then
    echo "  Skipped — generate-index.sh not found at $INDEX_SCRIPT"
elif [ ! -f "$HANDWRITTEN_DOCS_ABS/$INDEX_TEMPLATE" ]; then
    echo "  Skipped — $INDEX_TEMPLATE not found in $HANDWRITTEN_DOCS"
else
    bash "$INDEX_SCRIPT" "$HANDWRITTEN_DOCS_ABS" "$INDEX_TEMPLATE" "$INDEX_OUTPUT"
    echo "  $INDEX_OUTPUT regenerated from $HANDWRITTEN_DOCS/$INDEX_TEMPLATE"
fi

# ── Step 2: Build source reference (Doxygen → doxybook2 → navigation) ────────
# build-navigation.py (called at end of this step) reads SUMMARY.md to build
# the literate-nav SUMMARY_EXT.md for MkDocs.
echo ""
echo "=============================================="
echo "  Step 2: Building source reference"
echo "=============================================="

if bash "$BUILD_SOURCE_REFERENCE_SCRIPT"; then
    echo "  Source reference build completed successfully"
else
    exit_code=$?
    echo "Error: build-source-reference.sh failed with exit code $exit_code" >&2
    exit $exit_code
fi

# ── Step 3: Compile widget TypeScript (before mkdocs copies JS) ────────────
echo ""
echo "=============================================="
echo "  Step 3:  Compiling ask widget TypeScript"
echo "=============================================="
"$SCRIPT_DIR/build-widget.sh" --compile-only

# ── Step 4: Build MkDocs site ─────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Step 4: Building MkDocs site"
echo "=============================================="

SITE_DIR_ABS="$TEMPLATE_ROOT/$SITE_DIR"
echo "  Output directory: $SITE_DIR_ABS"

if properdocs build -f "$MKDOCS_YML" --site-dir "$SITE_DIR_ABS" $STRICT_FLAG; then
    echo "  ProperDocs build completed successfully"
else
    exit_code=$?
    echo "Error: properdocs build failed with exit code $exit_code" >&2
    exit $exit_code
fi

# ── Step 5: Build search vocabulary for the typo-tolerant ask worker ──────────
echo ""
echo "=============================================="
echo "  Step 5:  Building search vocabulary"
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

# ── Step 6: Generate ask-config.json (after mkdocs, before gzip) ───────────
echo ""
echo "=============================================="
echo "  Step 6:  Generating ask-config.json"
echo "=============================================="
"$SCRIPT_DIR/build-widget.sh" --config-only

echo ""
echo "=============================================="
echo "  Step 7: Generating llms.txt agent catalogs"
echo "=============================================="
python3 "$SCRIPT_DIR/build-llms.py" "$@"

# ── Step 8: Gzip JSON files for local dev (fetch-gzip.js wrapper) ──────────
echo ""
echo "=============================================="
echo "  Step 8:  Gzipping JSON files for dev server"
echo "=============================================="

GZIP_JSON="${GZIP_JSON:-True}"
if [ "$GZIP_JSON" = "True" ]; then
    count=0
    while IFS= read -r -d '' f; do
        if gzip -fk "$f" 2>/dev/null; then
            rm "$f"
            count=$((count + 1))
        else
            echo "  Warning: gzip failed for ${f#$SITE_DIR_ABS/}" >&2
        fi
    done < <(find "$SITE_DIR_ABS" -name "*.json" -type f ! -name "*.json.gz" -print0)
    echo "  Gzipped $count .json files (raw .json deleted, fetch-gzip.js + search-gzip.js serve .gz)"
else
    echo "  Skipped — deploy.cloudflare.gzip_json is not True"
fi

# ── Success ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Full build complete"
echo "  Site output: $SITE_DIR_ABS"
echo "=============================================="

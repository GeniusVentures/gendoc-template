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
fi

# ── Validate prerequisites ────────────────────────────────────────────────────
if [ ! -f "$GENDOC_YML" ]; then
    echo "Error: gendoc.yml not found at $GENDOC_YML" >&2
    echo "       Create one by copying gendoc.yml.example and filling in your project values." >&2
    exit 1
fi

DOXYFILE_TPL="$TEMPLATE_ROOT/doxygen-template/Doxyfile.template"
if [ ! -f "$DOXYFILE_TPL" ]; then
    echo "Error: Doxyfile.template not found at $DOXYFILE_TPL" >&2
    exit 1
fi

DOXYBOOK_JSON="$TEMPLATE_ROOT/scripts/doxybook.json"
if [ ! -f "$DOXYBOOK_JSON" ]; then
    echo "Error: doxybook.json not found at $DOXYBOOK_JSON" >&2
    exit 1
fi

if ! command -v doxygen &>/dev/null; then
    echo "Error: doxygen not found." >&2
    echo "       Install with: brew install doxygen (macOS) or apt-get install doxygen (Linux)" >&2
    exit 1
fi

if ! command -v doxybook2 &>/dev/null; then
    echo "Error: doxybook2 not found." >&2
    echo "       Run:   bash gendoc-template/scripts/install-deps.sh" >&2
    echo "       Or download manually from:" >&2
    echo "       https://github.com/GeniusVentures/doxybook2/releases/tag/v1.6.3" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found." >&2
    exit 1
fi

# ── Read gendoc.yml values ────────────────────────────────────────────────────
echo "Reading gendoc.yml..."

eval "$(python3 "$SCRIPT_DIR/read-yaml.py" "$GENDOC_YML" --batch \
    "project.name=PROJECT_NAME" \
    "project.number=PROJECT_NUMBER" \
    "project.brief=PROJECT_BRIEF" \
    "project.logo=PROJECT_LOGO" \
    "paths.handwritten_docs=HANDWRITTEN_DOCS" \
    "paths.exclude_patterns=EXCLUDE_PATTERNS_RAW:join-space" \
    "doxygen.output_dir=DOXY_OUTPUT_DIR" \
    "doxygen.generate_xml=GENERATE_XML_RAW" \
    "doxygen.generate_html=GENERATE_HTML_RAW" \
    "doxygen.recursive=RECURSIVE_RAW" \
    "doxygen.strip_from_path=STRIP_FROM_PATH" \
    "doxygen.full_path_names=FULL_PATH_NAMES_RAW" \
)"

if [ -z "$EXCLUDE_PATTERNS_RAW" ]; then
    EXCLUDE_PATTERNS_RAW=""
fi

# ── Validate required values ──────────────────────────────────────────────────
if [ -z "$PROJECT_NAME" ]; then
    echo "Error: project.name is required in gendoc.yml" >&2
    exit 1
fi
if [ -z "$HANDWRITTEN_DOCS" ]; then
    echo "Error: paths.handwritten_docs is required in gendoc.yml" >&2
    exit 1
fi
if [ -z "$DOXY_OUTPUT_DIR" ]; then
    echo "Error: doxygen.output_dir is required in gendoc.yml" >&2
    exit 1
fi

# ── Resolve paths relative to HOST_ROOT ───────────────────────────────────────
resolve_path() {
    if [ -z "$1" ]; then
        echo ""
        return
    fi
    if [[ "$1" == /* ]]; then
        echo "$1"
    else
        echo "$HOST_ROOT/$1"
    fi
}

DOXY_OUTPUT_DIR_ABS=$(resolve_path "$DOXY_OUTPUT_DIR")
HANDWRITTEN_DOCS_ABS=$(resolve_path "$HANDWRITTEN_DOCS")

# Convert true/false to YES/NO
bool_to_yesno() {
    case "$1" in
        true|True|TRUE|yes|Yes|YES|1) echo "YES" ;;
        *) echo "NO" ;;
    esac
}

GENERATE_XML=$(bool_to_yesno "$GENERATE_XML_RAW")
GENERATE_HTML=$(bool_to_yesno "$GENERATE_HTML_RAW")
RECURSIVE=$(bool_to_yesno "$RECURSIVE_RAW")
FULL_PATH_NAMES=$(bool_to_yesno "$FULL_PATH_NAMES_RAW")

# ── Emit the source_references list as a manifest delimited by the ASCII ──────
# unit separator (\x1f).  This byte is NOT an IFS-whitespace character, so bash
# `read` preserves empty fields (e.g. a set with no exclude_patterns).  A tab
# delimiter would collapse consecutive tabs and shift every following field,
# silently dropping values like base_url.  Fields (none contains \x1f):
#   name  label  language  source  file_patterns(space-joined)
#   exclude_patterns(space-joined)  output_subdir  base_url
MANIFEST=$(python3 -c "
import sys, yaml
with open(sys.argv[1], 'r') as f:
    cfg = yaml.safe_load(f) or {}
sets = cfg.get('source_references') or []
for s in sets:
    name = str(s.get('name', '') or '')
    label = str(s.get('label', '') or name)
    language = str(s.get('language', '') or '')
    source = s.get('source', '') or ''
    if isinstance(source, list):
        source = ' '.join(str(p) for p in source)
    else:
        source = str(source)
    file_patterns = ' '.join(str(p) for p in (s.get('file_patterns') or []))
    exclude_patterns = ' '.join(str(p) for p in (s.get('exclude_patterns') or []))
    output_subdir = str(s.get('output_subdir', '') or '')
    base_url = str(s.get('base_url', '') or '')
    sys.stdout.write('\x1f'.join([name, label, language, source, file_patterns,
                                  exclude_patterns, output_subdir, base_url]) + '\n')
" "$GENDOC_YML")

if [ -z "$MANIFEST" ]; then
    echo "Error: no source_references defined in gendoc.yml" >&2
    echo "       Add a 'source_references:' list with at least one set." >&2
    exit 1
fi

# ── Helpers: convert space-joined lists to Doxyfile backslash-continued form ──
to_doxy_list() {
    local out=""
    local item
    for item in $1; do
        if [ -z "$out" ]; then
            out="$item"
        else
            out="$out \\"$'\n'"                         $item"
        fi
    done
    printf '%s' "$out"
}

# ── Build one source reference set ────────────────────────────────────────────
build_one_set() {
    local name="$1" label="$2" language="$3" source="$4"
    local file_pats="$5" set_excludes="$6" out_subdir="$7" base_url="$8"

    echo ""
    echo "----------------------------------------------"
    echo "  Source set: $label ($name)"
    echo "----------------------------------------------"

    if [ -z "$out_subdir" ]; then
        echo "Error: set '$name' has no output_subdir — skipping" >&2
        return 0
    fi

    # Resolve source INPUT dirs (space-separated) relative to HOST_ROOT.
    local resolved=""
    local dir
    for dir in $source; do
        [ -n "$dir" ] && resolved="$resolved $(resolve_path "$dir")"
    done
    resolved="${resolved# }"
    if [ -z "$resolved" ]; then
        echo "Warning: set '$name' has no source — skipping" >&2
        return 0
    fi

    local input_doxy
    input_doxy=$(to_doxy_list "$resolved")

    # Global excludes apply to every set; per-set excludes are appended.
    local all_excludes="$EXCLUDE_PATTERNS_RAW $set_excludes"
    local exclude_doxy
    exclude_doxy=$(to_doxy_list "$all_excludes")

    local file_patterns_doxy
    file_patterns_doxy=$(to_doxy_list "$file_pats")

    # Per-set intermediate output: doxygen-output/<name>/
    local set_doxy_dir="$DOXY_OUTPUT_DIR_ABS/$name"
    local set_output_rel="$DOXY_OUTPUT_DIR/$name"
    mkdir -p "$set_doxy_dir"

    # ── Generate Doxyfile from template ──────────────────────────────────────
    local doxyfile_out="$set_doxy_dir/Doxyfile"
    cp "$DOXYFILE_TPL" "$doxyfile_out"

    # -i.bak works with both GNU sed (Linux) and BSD sed (macOS).
    sed -i.bak \
        -e 's|{{PROJECT_NAME}}|'"$PROJECT_NAME"'|g' \
        -e 's|{{PROJECT_NUMBER}}|'"$PROJECT_NUMBER"'|g' \
        -e 's|{{PROJECT_BRIEF}}|'"$PROJECT_BRIEF"'|g' \
        -e 's|{{PROJECT_LOGO}}|'"$PROJECT_LOGO"'|g' \
        -e 's|{{OUTPUT_DIRECTORY}}|'"$set_output_rel"'|g' \
        -e 's|{{GENERATE_XML}}|'"$GENERATE_XML"'|g' \
        -e 's|{{GENERATE_HTML}}|'"$GENERATE_HTML"'|g' \
        -e 's|{{RECURSIVE}}|'"$RECURSIVE"'|g' \
        -e 's|{{FULL_PATH_NAMES}}|'"$FULL_PATH_NAMES"'|g' \
        -e 's|{{STRIP_FROM_PATH}}|'"$STRIP_FROM_PATH"'|g' \
        "$doxyfile_out"
    rm -f "${doxyfile_out}.bak"

    python3 -c "
import sys
with open(sys.argv[1], 'r') as f:
    content = f.read()
content = content.replace('{{INPUT_DIRS}}', sys.argv[2])
content = content.replace('{{FILE_PATTERNS}}', sys.argv[3])
content = content.replace('{{EXCLUDE_PATTERNS}}', sys.argv[4])
with open(sys.argv[1], 'w') as f:
    f.write(content)
" "$doxyfile_out" "$input_doxy" "$file_patterns_doxy" "$exclude_doxy"

    echo "  Doxyfile written to $doxyfile_out"

    # ── Generate doxybook config (per-set base_url) ──────────────────────────
    local doxybook_out="$set_doxy_dir/doxybook.json"
    cp "$DOXYBOOK_JSON" "$doxybook_out"
    sed -i.bak 's|{{BASE_URL}}|'"$base_url"'|g' "$doxybook_out"
    rm -f "${doxybook_out}.bak"
    echo "  doxybook.json written to $doxybook_out"

    # ── Run doxygen ──────────────────────────────────────────────────────────
    echo "  Running doxygen..."
    (cd "$HOST_ROOT" && doxygen "$doxyfile_out")

    local doxy_xml_dir="$set_doxy_dir/xml"
    if [ ! -d "$doxy_xml_dir" ]; then
        echo "Error: Doxygen XML output not found at $doxy_xml_dir" >&2
        exit 1
    fi
    echo "  Doxygen completed — XML: $doxy_xml_dir"

    # ── Run doxybook2 → handwritten_docs/<output_subdir> ─────────────────────
    local api_output_abs="$HANDWRITTEN_DOCS_ABS/$out_subdir"
    mkdir -p "$api_output_abs"
    echo "  Running doxybook2..."
    doxybook2 --input "$doxy_xml_dir" --output "$api_output_abs" -c "$doxybook_out"
    echo "  doxybook2 completed — Markdown: $api_output_abs"
}

# ── Build every configured source set ─────────────────────────────────────────
while IFS=$'\x1f' read -r name label language source file_pats set_excludes out_subdir base_url; do
    [ -z "$name" ] && continue
    build_one_set "$name" "$label" "$language" "$source" "$file_pats" \
                  "$set_excludes" "$out_subdir" "$base_url"
done <<< "$MANIFEST"

# ── Run navigation builder (handles all sets from gendoc.yml) ─────────────────
echo ""
echo "Running navigation builder..."
NAV_SCRIPT="$SCRIPT_DIR/build-navigation.py"
if [ ! -f "$NAV_SCRIPT" ]; then
    echo "Warning: build-navigation.py not found at $NAV_SCRIPT — skipping navigation generation" >&2
else
    python3 "$NAV_SCRIPT" --docs-dir "$HANDWRITTEN_DOCS_ABS" --gendoc-config "$GENDOC_YML"
fi

# ── Success ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Source reference build complete"
echo "  Markdown output under: $HANDWRITTEN_DOCS_ABS/<output_subdir>"
echo "  Doxygen XML under:     $DOXY_OUTPUT_DIR_ABS/<name>/xml"
echo "=============================================="

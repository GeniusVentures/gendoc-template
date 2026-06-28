#!/usr/bin/env bash
set -euo pipefail

# ── Locate template root and host project root ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$TEMPLATE_ROOT/gendoc.yml"

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
    echo "       Install from: https://github.com/matusnovak/doxybook2" >&2
    echo "       npm install -g doxybook2" >&2
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

PROJECT_NAME=$(read_yaml "project.name")
PROJECT_NUMBER=$(read_yaml "project.number")
PROJECT_BRIEF=$(read_yaml "project.brief")
PROJECT_LOGO=$(read_yaml "project.logo")
CPP_SOURCE=$(read_yaml "paths.cpp_source")
HANDWRITTEN_DOCS=$(read_yaml "paths.handwritten_docs")
EXCLUDE_PATTERNS_RAW=$(read_yaml "paths.exclude_patterns")
DOXY_OUTPUT_DIR=$(read_yaml "doxygen.output_dir")
GENERATE_XML_RAW=$(read_yaml "doxygen.generate_xml")
GENERATE_HTML_RAW=$(read_yaml "doxygen.generate_html")
FILE_PATTERNS_RAW=$(read_yaml "doxygen.file_patterns")
RECURSIVE_RAW=$(read_yaml "doxygen.recursive")
STRIP_FROM_PATH=$(read_yaml "doxygen.strip_from_path")
API_OUTPUT_SUBDIR=$(read_yaml "api_reference.output_subdir")
BASE_URL=$(read_yaml "api_reference.base_url")

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

# Default: if cpp_source is empty, default to src
if [ -z "$CPP_SOURCE" ]; then
    CPP_SOURCE="src"
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
API_OUTPUT_ABS="$HANDWRITTEN_DOCS_ABS/$API_OUTPUT_SUBDIR"

# Resolve cpp_source paths (space-separated)
CPP_SOURCE_RESOLVED=""
for dir in $CPP_SOURCE; do
    if [ -n "$dir" ]; then
        CPP_SOURCE_RESOLVED="$CPP_SOURCE_RESOLVED $(resolve_path "$dir")"
    fi
done
CPP_SOURCE_RESOLVED="${CPP_SOURCE_RESOLVED# }"

# ── Convert gendoc.yml bool/list values to Doxyfile format ────────────────────
# Convert space-separated cpp_source to Doxyfile backslash-continued format
INPUT_DIRS_DOXY=""
for dir in $CPP_SOURCE_RESOLVED; do
    if [ -z "$INPUT_DIRS_DOXY" ]; then
        INPUT_DIRS_DOXY="$dir"
    else
        INPUT_DIRS_DOXY="$INPUT_DIRS_DOXY \\"$'\n'"                         $dir"
    fi
done

# Convert space-separated file_patterns to Doxyfile backslash-continued format
FILE_PATTERNS_DOXY=""
for pat in $FILE_PATTERNS_RAW; do
    if [ -z "$FILE_PATTERNS_DOXY" ]; then
        FILE_PATTERNS_DOXY="$pat"
    else
        FILE_PATTERNS_DOXY="$FILE_PATTERNS_DOXY \\"$'\n'"                         $pat"
    fi
done

# Convert exclude_patterns to Doxyfile backslash-continued format
EXCLUDE_PATTERNS_DOXY=""
for pat in $EXCLUDE_PATTERNS_RAW; do
    if [ -z "$EXCLUDE_PATTERNS_DOXY" ]; then
        EXCLUDE_PATTERNS_DOXY="$pat"
    else
        EXCLUDE_PATTERNS_DOXY="$EXCLUDE_PATTERNS_DOXY \\"$'\n'"                         $pat"
    fi
done

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

# ── Generate Doxyfile from template ───────────────────────────────────────────
echo "Generating Doxyfile from template..."
mkdir -p "$DOXY_OUTPUT_DIR_ABS"
DOXYFILE_OUT="$DOXY_OUTPUT_DIR_ABS/Doxyfile"

# sed substitutions — use placeholder format for safe multiline replacement
cp "$DOXYFILE_TPL" "$DOXYFILE_OUT"

# Single-line substitutions (safe with sed)
sed -i '' \
    -e 's|{{PROJECT_NAME}}|'"$PROJECT_NAME"'|g' \
    -e 's|{{PROJECT_NUMBER}}|'"$PROJECT_NUMBER"'|g' \
    -e 's|{{PROJECT_BRIEF}}|'"$PROJECT_BRIEF"'|g' \
    -e 's|{{PROJECT_LOGO}}|'"$PROJECT_LOGO"'|g' \
    -e 's|{{OUTPUT_DIRECTORY}}|'"$DOXY_OUTPUT_DIR"'|g' \
    -e 's|{{GENERATE_XML}}|'"$GENERATE_XML"'|g' \
    -e 's|{{GENERATE_HTML}}|'"$GENERATE_HTML"'|g' \
    -e 's|{{RECURSIVE}}|'"$RECURSIVE"'|g' \
    -e 's|{{STRIP_FROM_PATH}}|'"$STRIP_FROM_PATH"'|g' \
    "$DOXYFILE_OUT"

# Multiline substitutions — use python3 for reliability
python3 -c "
import sys
with open(sys.argv[1], 'r') as f:
    content = f.read()
content = content.replace('{{INPUT_DIRS}}', sys.argv[2])
content = content.replace('{{FILE_PATTERNS}}', sys.argv[3])
content = content.replace('{{EXCLUDE_PATTERNS}}', sys.argv[4])
with open(sys.argv[1], 'w') as f:
    f.write(content)
" "$DOXYFILE_OUT" "$INPUT_DIRS_DOXY" "$FILE_PATTERNS_DOXY" "$EXCLUDE_PATTERNS_DOXY"

echo "  Doxyfile written to $DOXYFILE_OUT"

# ── Generate doxybook config from template ────────────────────────────────────
echo "Generating doxybook config..."
DOXYBOOK_OUT="$DOXY_OUTPUT_DIR_ABS/doxybook.json"
cp "$DOXYBOOK_JSON" "$DOXYBOOK_OUT"
sed -i '' 's|{{BASE_URL}}|'"$BASE_URL"'|g' "$DOXYBOOK_OUT"
echo "  doxybook.json written to $DOXYBOOK_OUT"

# ── Run doxygen ───────────────────────────────────────────────────────────────
echo "Running doxygen..."
cd "$HOST_ROOT"
if doxygen "$DOXYFILE_OUT"; then
    echo "  Doxygen completed successfully"
    echo "  XML output: $DOXY_OUTPUT_DIR_ABS/xml/"
else
    echo "Error: Doxygen failed with exit code $?" >&2
    exit 1
fi

# ── Run doxybook2 ────────────────────────────────────────────────────────────
echo "Running doxybook2..."
DOXY_XML_DIR="$DOXY_OUTPUT_DIR_ABS/xml"
if [ ! -d "$DOXY_XML_DIR" ]; then
    echo "Error: Doxygen XML output directory not found at $DOXY_XML_DIR" >&2
    exit 1
fi

mkdir -p "$API_OUTPUT_ABS"
if doxybook2 --input "$DOXY_XML_DIR" --output "$API_OUTPUT_ABS" -c "$DOXYBOOK_OUT"; then
    echo "  doxybook2 completed successfully"
    echo "  Markdown output: $API_OUTPUT_ABS/"
else
    echo "Error: doxybook2 failed with exit code $?" >&2
    exit 1
fi

# ── Run navigation builder ───────────────────────────────────────────────────
echo "Running navigation builder..."
NAV_SCRIPT="$SCRIPT_DIR/build_navigation.py"
if [ ! -f "$NAV_SCRIPT" ]; then
    echo "Warning: build_navigation.py not found at $NAV_SCRIPT — skipping navigation generation" >&2
else
    python3 "$NAV_SCRIPT" --api-dir "$API_OUTPUT_ABS"
fi

# ── Success ───────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  API Reference build complete"
echo "  Markdown output: $API_OUTPUT_ABS"
echo "  Doxygen XML:     $DOXY_XML_DIR"
echo "=============================================="

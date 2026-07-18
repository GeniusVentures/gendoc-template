#!/bin/bash
# Generate a markdown navigation index from headings in the target documentation directory.
# Extracts H1/H2/H3 headings, sorts files by chapter number (from first heading),
# groups headings per file, indents sub-docs under parent chapter.
#
# Usage: generate-index.sh <docs-dir> [template-file] [output-file]
#   docs-dir       Path to the hand-written docs directory.
#   template-file  Template filename within docs-dir (default: index.md.template).
#   output-file    Generated filename within docs-dir (default: index.md).

set -euo pipefail

DOCS_DIR="${1:-}"
TEMPLATE_FILE="${2:-index.md.template}"
OUTPUT_FILE="${3:-index.md}"

if [ -z "$DOCS_DIR" ]; then
    echo "Usage: $0 <docs-dir> [template-file] [output-file]" >&2
    exit 1
fi
if [ ! -d "$DOCS_DIR" ]; then
    echo "Error: $DOCS_DIR is not a directory" >&2
    exit 1
fi

OUTPUT="$DOCS_DIR/$OUTPUT_FILE"
TEMPLATE="$DOCS_DIR/$TEMPLATE_FILE"

if [ ! -f "$TEMPLATE" ]; then
    echo "Error: template not found: $TEMPLATE" >&2
    exit 1
fi

slugify() {
    echo "$1" \
        | tr '[:upper:]' '[:lower:]' \
        | sed -E '
            s/\*\*//g
            s/`//g
            s/—/-/g
            s/[^a-z0-9_ -]//g
            s/  +/ /g
            s/ /-/g
            s/--*/-/g
            s/^-//
            s/-$//
        '
}

# Extract the first number found in any H1 heading.
# Falls back to H2 only if no H1 has a number.
get_chapter() {
    local f="$1"
    local num
    num=$(awk '
        /^# /  { s=$0; sub(/^# /, "", s); gsub(/\*\*/, "", s); gsub(/^ +| +$/, "", s);
                 if (match(s, /[0-9]+(\.[0-9]+)?/)) { print substr(s, RSTART, RLENGTH); exit } }
        /^## / { exit }
    ' "$f")
    if [[ -z "$num" ]]; then
        num=$(awk '
            /^## / { s=$0; sub(/^## /, "", s); gsub(/\*\*/, "", s); gsub(/^ +| +$/, "", s);
                     if (match(s, /[0-9]+(\.[0-9]+)?/)) { print substr(s, RSTART, RLENGTH); exit } }
        ' "$f")
    fi
    echo "$num"
}

pad_key() {
    local num="$1"
    if [[ -z "$num" ]]; then
        echo "99999"
        return
    fi
    local int="${num%.*}"
    local frac="${num#*.}"
    [[ "$frac" == "$num" ]] && frac=""
    printf -v p "%08d" "$int" 2>/dev/null || p="99999999"
    [[ -n "$frac" ]] && echo "${p}.${frac}" || echo "$p"
}

is_sub() {
    local f="$1"
    awk '/^# /  { print "no";  exit }
         /^## / { print "yes"; exit }' "$f"
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

for file in "$DOCS_DIR"/*.md; do
    filename="$(basename "$file")"
    case "$filename" in
        "$OUTPUT_FILE"|"$TEMPLATE_FILE"|SUMMARY_EXT.md|README.md) continue ;;
    esac

    chap="$(get_chapter "$file")"
    key="$(pad_key "$chap")"
    sub="$(is_sub "$file")"

    awk '
        /^# /   { print "1\t" substr($0, 3) }
        /^## /  { print "2\t" substr($0, 4) }
        /^### / { print "3\t" substr($0, 5) }
    ' "$file" > "$TMPDIR/raw_$$" || true

    out="$TMPDIR/${key}_${filename}"

    if [[ ! -s "$TMPDIR/raw_$$" ]]; then
        label="${filename%.md}"
        printf '0|%s|%s|\n' "$label" "$filename" > "$out"
        continue
    fi

    line_num=0
    first_hlevel=""
    while IFS=$'\t' read -r hlevel raw_text; do
        line_num=$((line_num + 1))
        [[ -z "$first_hlevel" ]] && first_hlevel="$hlevel"

        clean="$(echo "$raw_text" \
            | sed -E 's/^\*\*//; s/\*\*$//' \
            | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
        anchor="$(slugify "$clean")"

        if [[ "$sub" == "yes" ]]; then
            if (( line_num == 1 )); then
                indent=1
            elif (( hlevel <= first_hlevel )); then
                indent=2
            else
                indent=2
            fi
        else
            indent=$((hlevel - 1))
        fi

        printf '%d|%s|%s|%s\n' "$indent" "$clean" "$filename" "$anchor"
    done < "$TMPDIR/raw_$$" > "$out"
    rm -f "$TMPDIR/raw_$$"
done

sed '/<!-- INDEX_LIST -->/q' "$TEMPLATE" > "$OUTPUT"

for entry in "$TMPDIR"/*; do
    [[ -f "$entry" ]] || continue
    while IFS='|' read -r indent text fname anchor; do
        case "$indent" in
            0) prefix="- " ;;
            1) prefix="  - " ;;
            2) prefix="    - " ;;
            *) prefix="- " ;;
        esac

        printf -- '%s[%s](./%s#%s)\n' "$prefix" "$text" "$fname" "$anchor"
    done < "$entry"
done >> "$OUTPUT"

sed '1,/<!-- INDEX_LIST -->/d' "$TEMPLATE" >> "$OUTPUT"

echo "Generated: $OUTPUT"

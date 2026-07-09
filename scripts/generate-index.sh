#!/bin/bash
# Generate index.md from index.md.template in the target documentation directory.
# Extracts H1/H2/H3 headings, sorts files by chapter number (from first heading),
# groups headings per file, indents sub-docs under parent chapter.
#
# Usage: generate-index.sh <docs-dir>
#   docs-dir   Path to the hand-written docs directory containing .md files
#              and index.md.template.

set -euo pipefail

DOCS_DIR="${1:-}"
if [ -z "$DOCS_DIR" ]; then
    echo "Usage: $0 <docs-dir>" >&2
    exit 1
fi
if [ ! -d "$DOCS_DIR" ]; then
    echo "Error: $DOCS_DIR is not a directory" >&2
    exit 1
fi

OUTPUT="$DOCS_DIR/index.md"
TEMPLATE="$DOCS_DIR/index.md.template"

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
    # Scan ALL H1s for the first number.
    num=$(awk '
        /^# /  { s=$0; sub(/^# /, "", s); gsub(/\*\*/, "", s); gsub(/^ +| +$/, "", s);
                 if (match(s, /[0-9]+(\.[0-9]+)?/)) { print substr(s, RSTART, RLENGTH); exit } }
        /^## / { exit }
    ' "$f")
    # If no numbered H1, fall back to the first H2.
    if [[ -z "$num" ]]; then
        num=$(awk '
            /^## / { s=$0; sub(/^## /, "", s); gsub(/\*\*/, "", s); gsub(/^ +| +$/, "", s);
                     if (match(s, /[0-9]+(\.[0-9]+)?/)) { print substr(s, RSTART, RLENGTH); exit } }
        ' "$f")
    fi
    echo "$num"
}

# Pad chapter number for sorting.
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

# Determine if a file is a sub-doc (first heading is H2, not H1).
is_sub() {
    local f="$1"
    awk '/^# /  { print "no";  exit }
         /^## / { print "yes"; exit }' "$f"
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# -------------------------------------------------------------------
# Phase 1: For each .md file, emit headings into a per-file temp file,
# keyed by chapter number for sorted concatenation.
# -------------------------------------------------------------------
for file in "$DOCS_DIR"/*.md; do
    filename="$(basename "$file")"
    case "$filename" in index.md|index.md.template|SUMMARY_EXT.md) continue ;; esac

    chap="$(get_chapter "$file")"
    key="$(pad_key "$chap")"
    sub="$(is_sub "$file")"

    # Extract all headings into a temp file for this doc.
    awk '
        /^# /   { print "1\t" substr($0, 3) }
        /^## /  { print "2\t" substr($0, 4) }
        /^### / { print "3\t" substr($0, 5) }
    ' "$file" > "$TMPDIR/raw_$$" || true

    out="$TMPDIR/${key}_${filename}"

    if [[ ! -s "$TMPDIR/raw_$$" ]]; then
        # No headings found — fallback to filename-derived label.
        label="${filename%.md}"
        printf '0|%s|%s|\n' "$label" "$filename" > "$out"
        continue
    fi

    # Determine the heading level shift for sub-docs.
    # Sub-docs (no H1): first heading treated as indent-1 title, rest shift down.
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
            # Sub-doc: first heading → indent 1; later at same level → indent 2; deeper → indent 2
            if (( line_num == 1 )); then
                indent=1
            elif (( hlevel <= first_hlevel )); then
                indent=2
            else
                indent=2
            fi
        else
            # Primary doc: H1=0, H2=1, H3=2
            indent=$((hlevel - 1))
        fi

        printf '%d|%s|%s|%s\n' "$indent" "$clean" "$filename" "$anchor"
    done < "$TMPDIR/raw_$$" > "$out"
    rm -f "$TMPDIR/raw_$$"
done

# -------------------------------------------------------------------
# Phase 2: Write index.md from template + sorted entries.
# -------------------------------------------------------------------
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

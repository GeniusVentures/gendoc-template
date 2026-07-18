#!/usr/bin/env bash
# build-widget.sh -- compile the ask widget (ask-ai/widget-src) to ES modules
# at javascripts/ask/, and generate ask-config.json for the deployed site.
# Pass --compile-only to skip config generation (compile before mkdocs).
# Pass --config-only to skip compilation (config after mkdocs).
set -euo pipefail

MODE="all"
for arg in "$@"; do
    case "$arg" in
        --compile-only) MODE="compile" ;;
        --config-only)  MODE="config" ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$HOST_ROOT/gendoc.yml"

# ── Activate Python virtual environment ────────────────────────────────────────
VENV="$TEMPLATE_ROOT/.venv"
if [ -d "$VENV" ]; then
    export PATH="$VENV/bin:$PATH"
fi

read_yaml() {
    python3 "$SCRIPT_DIR/read-yaml.py" "$GENDOC_YML" "$1"
}

LLMS_ENABLED=$(read_yaml "llms.enabled")
ASK_ENABLED=$(read_yaml "llms.ask.enabled")

if [ "$LLMS_ENABLED" != "true" ] || [ "$ASK_ENABLED" != "true" ]; then
    echo "  Ask widget: disabled — skipping"
    exit 0
fi

# ── Step 1: Compile TypeScript widget source ────────────────────────────────
command -v npx >/dev/null 2>&1 || { echo "ERROR: npx not found -- Node.js is a prerequisite" >&2; exit 1; }

if [ "$MODE" != "config" ]; then
    echo "  Compiling ask-ai TypeScript..."
    npx -y -p typescript@5 tsc -p "$TEMPLATE_ROOT/ask-ai/widget-src"
fi

# ── Step 2: Generate ask-config.json ────────────────────────────────────────
if [ "$MODE" = "compile" ]; then
    echo "  Skipping ask-config.json (--compile-only)"
    exit 0
fi
SITE_DIR=$(read_yaml "mkdocs.site_dir")
SITE_DIR="${SITE_DIR:-site}"
SITE_DIR_ABS="$TEMPLATE_ROOT/$SITE_DIR"

# Endpoint resolution: configured value takes priority (shared-worker / custom
# domain scenario); otherwise fall back to the auto-captured .endpoint file
# written by setup.sh or deploy-ask.sh.
ASK_ENDPOINT=$(read_yaml "llms.ask.endpoint")
if [ -z "$ASK_ENDPOINT" ]; then
    ENDPOINT_FILE="$TEMPLATE_ROOT/ask-ai/.endpoint"
    if [ ! -f "$ENDPOINT_FILE" ]; then
        echo "  WARNING: Neither llms.ask.endpoint nor ask-ai/.endpoint found."
        echo "  Run setup.sh to deploy the ask worker, or set llms.ask.endpoint"
        echo "  to a shared worker URL. Skipping ask-config.json."
        exit 0
    fi
    ASK_ENDPOINT=$(head -1 "$ENDPOINT_FILE" | tr -d '\n')
fi

ASK_TITLE=$(read_yaml "llms.ask.title")
PROJECT_NAME=$(read_yaml "project.name")
ASK_TITLE="${ASK_TITLE:-Ask ${PROJECT_NAME:-Docs}}"

ASK_PLACEHOLDER=$(read_yaml "llms.ask.placeholder")
ASK_PLACEHOLDER="${ASK_PLACEHOLDER:-Ask a question...}"

SITE_URL=$(read_yaml "llms.site_url")
LLMS_FULL_URL="${SITE_URL%/}/llms-full.txt"

echo "  Generating ask-config.json (endpoint: $ASK_ENDPOINT)"
mkdir -p "$SITE_DIR_ABS"

python3 -c "
import json, sys
cfg = {
    'enabled': True,
    'endpoint': sys.argv[1],
    'title': sys.argv[2],
    'placeholder': sys.argv[3],
    'llms_full_url': sys.argv[4],
}
with open(sys.argv[5], 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" "$ASK_ENDPOINT" "$ASK_TITLE" "$ASK_PLACEHOLDER" "$LLMS_FULL_URL" "$SITE_DIR_ABS/ask-config.json"

echo "  Wrote $SITE_DIR_ABS/ask-config.json"

# Cloudflare Pages otherwise may keep unchanged module URLs in a browser cache
# after a deployment. The widget is compiled on every build, so require
# revalidation for its module graph and runtime configuration.
cat >> "$SITE_DIR_ABS/_headers" <<'HEADERS'

/javascripts/ask/*
  Cache-Control: no-cache, must-revalidate
/ask-config.json
  Cache-Control: no-cache, must-revalidate
HEADERS
echo "  Wrote Ask widget cache rules to $SITE_DIR_ABS/_headers"

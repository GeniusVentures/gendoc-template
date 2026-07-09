#!/usr/bin/env bash
set -euo pipefail

# ── Locate paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$HOST_ROOT/gendoc.yml"

# ── Python virtual environment ────────────────────────────────────────────────
VENV="$TEMPLATE_ROOT/.venv"
if [ ! -d "$VENV" ]; then
    echo "Creating Python virtual environment at $VENV ..."
    python3 -m venv "$VENV"
fi
export PATH="$VENV/bin:$PATH"

# Install/refresh required packages.
pip install --quiet mkdocs mkdocs-material mkdocs-literate-nav pyyaml

if [ ! -f "$GENDOC_YML" ]; then
    echo "Error: gendoc.yml not found at $GENDOC_YML" >&2
    echo "       Create one by copying gendoc-template/gendoc.yml.example and filling in your project values." >&2
    exit 1
fi

if ! command -v wrangler &>/dev/null; then
    echo "Error: wrangler not found." >&2
    echo "       Install with: npm install -g wrangler" >&2
    exit 1
fi

if ! command -v python3 &>/dev/null; then
    echo "Error: python3 not found." >&2
    exit 1
fi

# ── Verify wrangler is authenticated ─────────────────────────────────────────
if ! wrangler whoami &>/dev/null; then
    echo "Not logged into Cloudflare. Opening browser for OAuth login..."
    wrangler login
    echo ""
fi

# ── Read gendoc.yml values ───────────────────────────────────────────────────
echo "Reading gendoc.yml..."

read_yaml() {
    python3 "$SCRIPT_DIR/read-yaml.py" "$GENDOC_YML" "$1"
}

# Like read_yaml, but joins a YAML list into a comma-separated string.
read_yaml_list() {
    python3 "$SCRIPT_DIR/read-yaml.py" "$GENDOC_YML" "$1" --join
}

PROJECT_NAME=$(read_yaml "project.name")
PAGES_PROJECT_NAME=$(read_yaml "deploy.cloudflare.pages_project_name")
PRODUCTION_BRANCH=$(read_yaml "deploy.cloudflare.production_branch")
CUSTOM_DOMAIN=$(read_yaml "deploy.cloudflare.custom_domain")
COMPATIBILITY_DATE=$(read_yaml "deploy.cloudflare.compatibility_date")
SITE_DIR=$(read_yaml "mkdocs.site_dir")

if [ -z "$PAGES_PROJECT_NAME" ]; then
    echo "Error: deploy.cloudflare.pages_project_name is required in gendoc.yml" >&2
    exit 1
fi

echo "  Project:        ${PROJECT_NAME:-(unnamed)}"
echo "  Pages project:  $PAGES_PROJECT_NAME"
echo "  Branch:         ${PRODUCTION_BRANCH:-main}"
if [ -n "$CUSTOM_DOMAIN" ]; then
    echo "  Custom domain:  $CUSTOM_DOMAIN"
fi

# ── Create Cloudflare Pages project ──────────────────────────────────────────
echo ""
echo "Creating Cloudflare Pages project '$PAGES_PROJECT_NAME'..."
echo ""

if wrangler pages project list | grep -q "$PAGES_PROJECT_NAME"; then
    echo "  Project '$PAGES_PROJECT_NAME' already exists — skipping creation."
else
    wrangler pages project create "$PAGES_PROJECT_NAME" \
        --production-branch "${PRODUCTION_BRANCH:-main}"

    echo ""
    echo "  Project created. First deploy will happen when you push to ${PRODUCTION_BRANCH:-main}"
    echo "  or run: gendoc-template/scripts/deploy.sh"
fi

# ── Custom domain instructions ────────────────────────────────────────────────
if [ -n "$CUSTOM_DOMAIN" ]; then
    echo ""
    echo "To set up a custom domain, configure it in the Cloudflare Dashboard:"
    echo ""
    echo "  1. Open: https://dash.cloudflare.com/ → Pages → $PAGES_PROJECT_NAME → Custom Domains"
    echo "  2. Add: $CUSTOM_DOMAIN"
    echo "  3. Create a CNAME record pointing $CUSTOM_DOMAIN to $PAGES_PROJECT_NAME.pages.dev"
    echo "  4. Cloudflare will auto-provision the SSL certificate"
fi

# ── Generate wrangler.toml from template ─────────────────────────────────────
SITE_DIR="${SITE_DIR:-site}"
SITE_DIR_ABS="$TEMPLATE_ROOT/$SITE_DIR"
COMPATIBILITY_DATE="${COMPATIBILITY_DATE:-2024-01-01}"
WRANGLER_TPL="$TEMPLATE_ROOT/wrangler.toml.template"
WRANGLER_OUT="$TEMPLATE_ROOT/wrangler.toml"

echo ""
echo "Generating wrangler.toml from template..."

python3 -c "
import sys
with open(sys.argv[1], 'r') as f:
    content = f.read()
content = content.replace('{{PAGES_PROJECT_NAME}}', sys.argv[2])
content = content.replace('{{COMPATIBILITY_DATE}}', sys.argv[3])
content = content.replace('{{SITE_DIR}}', sys.argv[4])
with open(sys.argv[5], 'w') as f:
    f.write(content)
" "$WRANGLER_TPL" "$PAGES_PROJECT_NAME" "$COMPATIBILITY_DATE" "$SITE_DIR_ABS" "$WRANGLER_OUT"

echo "  wrangler.toml written to $WRANGLER_OUT"

# ── Ask widget worker (optional) ─────────────────────────────────────────────
LLMS_ENABLED=$(read_yaml "llms.enabled")
ASK_ENABLED=$(read_yaml "llms.ask.enabled")
ASK_WORKER_NAME=""

if [ "$LLMS_ENABLED" = "true" ] && [ "$ASK_ENABLED" = "true" ]; then
    LLMS_SITE_URL=$(read_yaml "llms.site_url")
    if [ -z "$LLMS_SITE_URL" ]; then
        echo "Error: llms.site_url is required when llms.ask.enabled is true" >&2
        exit 1
    fi
    LLMS_SITE_URL="${LLMS_SITE_URL%/}"

    ASK_WORKER_NAME=$(read_yaml "llms.ask.worker_name")
    ASK_WORKER_NAME="${ASK_WORKER_NAME:-${PAGES_PROJECT_NAME}-ask}"
    ASK_BOT_NAME=$(read_yaml "llms.ask.title")
    ASK_BOT_NAME="${ASK_BOT_NAME:-${PROJECT_NAME:-Docs} Assistant}"
    ASK_ORIGINS=$(read_yaml_list "llms.ask.allowed_origins")
    ASK_ORIGINS="${ASK_ORIGINS:-$LLMS_SITE_URL}"
    ASK_PROVIDERS=$(read_yaml "llms.ask.providers")
    ASK_PROVIDERS="${ASK_PROVIDERS:-openrouter,gemini}"
    ASK_GEMINI_MODEL=$(read_yaml "llms.ask.gemini_model")
    ASK_GEMINI_MODEL="${ASK_GEMINI_MODEL:-gemini-2.5-flash}"
    ASK_OPENROUTER_MODELS=$(read_yaml "llms.ask.openrouter_models")
    ASK_OPENROUTER_MODELS="${ASK_OPENROUTER_MODELS:-nvidia/nemotron-3-super-120b-a12b:free,nvidia/nemotron-3-ultra-550b-a55b:free,nvidia/nemotron-3-nano-30b-a3b:free}"

    ASK_TPL="$TEMPLATE_ROOT/ask-ai/wrangler-ask.toml.template"
    ASK_OUT="$TEMPLATE_ROOT/ask-ai/wrangler-ask.toml"

    echo ""
    echo "Generating ask-ai/wrangler-ask.toml from template..."

    # Read configured endpoint for route injection (shared-worker scenario).
    ASK_ENDPOINT_CFG=$(read_yaml "llms.ask.endpoint")

    python3 -c "
import sys
from urllib.parse import urlparse

with open(sys.argv[1], 'r') as f:
    content = f.read()
tokens = {
    '{{WORKER_NAME}}': sys.argv[2],
    '{{COMPATIBILITY_DATE}}': sys.argv[3],
    '{{LLMS_URL}}': sys.argv[4] + '/llms.txt',
    '{{SITE_URL}}': sys.argv[4],
    '{{ALLOWED_ORIGINS}}': sys.argv[5],
    '{{BOT_NAME}}': sys.argv[6],
    '{{PROVIDERS}}': sys.argv[7],
    '{{GEMINI_MODEL}}': sys.argv[8],
    '{{OPENROUTER_MODELS}}': sys.argv[9],
}
for token, value in tokens.items():
    content = content.replace(token, value)

# When a custom endpoint is configured, append a [[routes]] section so
# traffic to that domain+path reaches this worker.
endpoint = sys.argv[11]
if endpoint:
    parsed = urlparse(endpoint)
    host = parsed.hostname or ''
    path = parsed.path.rstrip('/') or '/api/ask'
    route_path = '/'.join(path.split('/')[:-1] + ['*'])
    zone = '.'.join(host.split('.')[-2:])
    content += f'\n[[routes]]\npattern = \"{host}{route_path}\"\nzone_name = \"{zone}\"\n'

with open(sys.argv[10], 'w') as f:
    f.write(content)
" "$ASK_TPL" "$ASK_WORKER_NAME" "$COMPATIBILITY_DATE" "$LLMS_SITE_URL" \
      "$ASK_ORIGINS" "$ASK_BOT_NAME" "$ASK_PROVIDERS" "$ASK_GEMINI_MODEL" \
      "$ASK_OPENROUTER_MODELS" "$ASK_OUT" "$ASK_ENDPOINT_CFG"

    echo "  wrangler-ask.toml written to $ASK_OUT"

    echo ""
    echo "Deploying ask worker '$ASK_WORKER_NAME' (re-running syncs config changes)..."
    echo ""
    wrangler deploy --config "$ASK_OUT" 2>&1 | tee /tmp/ask-deploy.log
    DEPLOY_OUTPUT=$(cat /tmp/ask-deploy.log)

    # Resolve the endpoint so build-widget.sh can generate ask-config.json.
    # Precedence: configured llms.ask.endpoint (shared-worker / custom-domain
    # scenario), otherwise auto-capture the workers.dev URL from deploy output.
    CONFIGURED_ENDPOINT=$(read_yaml "llms.ask.endpoint")
    ENDPOINT_FILE="$TEMPLATE_ROOT/ask-ai/.endpoint"
    if [ -n "$CONFIGURED_ENDPOINT" ]; then
        echo "$CONFIGURED_ENDPOINT" > "$ENDPOINT_FILE"
        echo "  Endpoint (from gendoc.yml): $CONFIGURED_ENDPOINT"
    else
        AUTO_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
        if [ -n "$AUTO_URL" ]; then
            echo "${AUTO_URL}/api/ask" > "$ENDPOINT_FILE"
            echo "  Endpoint captured to $ENDPOINT_FILE"
        else
            echo "  WARNING: Could not auto-detect worker URL from deploy output."
            echo "  Set llms.ask.endpoint in gendoc.yml, or create"
            echo "  ask-ai/.endpoint manually with the worker URL + /api/ask."
        fi
    fi

    # ── Provider secrets (interactive, skippable, set once) ──────────────────
    if [ -t 0 ]; then
        echo ""
        echo "Provider API keys are stored as Worker secrets (press Enter to skip"
        echo "either one — a provider without a key is skipped in the chain)."
        read -r -s -p "  Gemini API key: " GEMINI_KEY; echo ""
        if [ -n "$GEMINI_KEY" ]; then
            printf '%s' "$GEMINI_KEY" | wrangler secret put GEMINI_API_KEY --name "$ASK_WORKER_NAME"
        fi
        read -r -s -p "  OpenRouter API key: " OPENROUTER_KEY; echo ""
        if [ -n "$OPENROUTER_KEY" ]; then
            printf '%s' "$OPENROUTER_KEY" | wrangler secret put OPENROUTER_API_KEY --name "$ASK_WORKER_NAME"
        fi
        unset GEMINI_KEY OPENROUTER_KEY
    else
        echo ""
        echo "  Non-interactive shell — set secrets manually (once):"
        echo "    wrangler secret put GEMINI_API_KEY     --name $ASK_WORKER_NAME"
        echo "    wrangler secret put OPENROUTER_API_KEY --name $ASK_WORKER_NAME"
    fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Setup complete"
echo "  Project:   $PAGES_PROJECT_NAME"
echo "  Pages URL: https://$PAGES_PROJECT_NAME.pages.dev"
if [ -n "$CUSTOM_DOMAIN" ]; then
    echo "  Custom:    https://$CUSTOM_DOMAIN"
fi
if [ -n "$ASK_WORKER_NAME" ]; then
    echo "  Ask worker: $ASK_WORKER_NAME (endpoint captured to ask-ai/.endpoint)"
fi
echo ""
echo "  Next: gendoc-template/scripts/build.sh"
echo "        gendoc-template/scripts/deploy.sh"
echo "=============================================="

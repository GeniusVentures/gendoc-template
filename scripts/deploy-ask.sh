#!/usr/bin/env bash
# deploy-ask.sh -- deploy the ask widget's Worker for this host project.
# Reads configuration from gendoc.yml (llms.* and deploy.cloudflare.*),
# generates a wrangler config from wrangler_ask_toml.template, and deploys.
#
# Run from the HOST PROJECT ROOT, like the other gendoc scripts:
#   gendoc-template/scripts/deploy-ask.sh
#
# Requires CF_API_TOKEN and CF_ACCOUNT_ID in the environment (same as
# deploy.sh). Secrets are set once per worker, manually:
#   wrangler secret put GEMINI_API_KEY     --name <worker-name>
#   wrangler secret put OPENROUTER_API_KEY --name <worker-name>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="${1:-gendoc.yml}"

# ── Activate Python virtual environment ────────────────────────────────────────
VENV="$TEMPLATE_ROOT/.venv"
if [ -d "$VENV" ]; then
    export PATH="$VENV/bin:$PATH"
fi

[ -f "$CONFIG" ] || { echo "ERROR: $CONFIG not found -- run from the host project root" >&2; exit 1; }
command -v wrangler >/dev/null 2>&1 || { echo "ERROR: wrangler not found (npm install -g wrangler)" >&2; exit 1; }
# When wrangler login (OAuth) is active, prefer it.  Fall back to API-token
# env vars for CI/CD headless deploys.
if wrangler whoami >/dev/null 2>&1; then
    USE_TOKEN_AUTH=false
else
    : "${CF_API_TOKEN:?ERROR: CF_API_TOKEN environment variable is not set (or run: wrangler login)}"
    : "${CF_ACCOUNT_ID:?ERROR: CF_ACCOUNT_ID environment variable is not set (or run: wrangler login)}"
    USE_TOKEN_AUTH=true
fi

# Generate wrangler-ask.toml from template + gendoc.yml
bash "$SCRIPT_DIR/generate-ask-config.sh" "$CONFIG"

# Source computed values back (subshell-safe)
VARS_FILE="$TEMPLATE_ROOT/ask-ai/.generated-vars"
if [ -f "$VARS_FILE" ]; then
    source "$VARS_FILE"
fi

echo "==> Deploying ask worker '$WORKER_NAME'"
if [ "$USE_TOKEN_AUTH" = true ]; then
  DEPLOY_OUTPUT=$(cd "$TEMPLATE_ROOT/ask-ai" && CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
    wrangler deploy --config "$GENERATED" 2>&1)
else
  DEPLOY_OUTPUT=$(cd "$TEMPLATE_ROOT/ask-ai" && wrangler deploy --config "$GENERATED" 2>&1)
fi
echo "$DEPLOY_OUTPUT"

# Resolve the endpoint so build-widget.sh can generate ask-config.json.
CONFIGURED_ENDPOINT=$(python3 -c "
import yaml
with open('$CONFIG', 'r') as f:
    cfg = yaml.safe_load(f) or {}
ask = cfg.get('llms', {}).get('ask', {})
print(ask.get('endpoint', '') or '')
")
ENDPOINT_FILE="$TEMPLATE_ROOT/ask-ai/.endpoint"
if [ -n "$CONFIGURED_ENDPOINT" ]; then
    echo "$CONFIGURED_ENDPOINT" > "$ENDPOINT_FILE"
    echo "Endpoint (from gendoc.yml): $CONFIGURED_ENDPOINT"
else
    AUTO_URL=$(echo "$DEPLOY_OUTPUT" | grep -oE 'https://[a-zA-Z0-9._-]+\.workers\.dev' | head -1)
    if [ -n "$AUTO_URL" ]; then
        echo "${AUTO_URL}/api/ask" > "$ENDPOINT_FILE"
        echo "Endpoint captured to $ENDPOINT_FILE"
    else
        echo "WARNING: Could not auto-detect worker URL from deploy output."
    fi
fi

echo ""
echo "If not done yet, set the provider secrets once:"
echo "  wrangler secret put GEMINI_API_KEY     --name $WORKER_NAME"
echo "  wrangler secret put OPENROUTER_API_KEY --name $WORKER_NAME"

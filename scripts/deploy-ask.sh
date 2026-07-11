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
# CF_API_TOKEN / CF_ACCOUNT_ID are required for CI/CD headless deploys.
# For local dev, wrangler login (OAuth) is sufficient -- skip the check.
if ! wrangler whoami >/dev/null 2>&1; then
    : "${CF_API_TOKEN:?ERROR: CF_API_TOKEN environment variable is not set (or run: wrangler login)}"
    : "${CF_ACCOUNT_ID:?ERROR: CF_ACCOUNT_ID environment variable is not set (or run: wrangler login)}"
fi

# Pull every needed value out of gendoc.yml in one Python pass.
# Output: one KEY=VALUE per line, consumed into shell variables below.
eval "$(python3 - "$CONFIG" <<'PY'
import sys, yaml, shlex

cfg = yaml.safe_load(open(sys.argv[1])) or {}
llms = cfg.get("llms") or {}
ask = llms.get("ask") or {}
cf = (cfg.get("deploy") or {}).get("cloudflare") or {}
project = cfg.get("project") or {}

if not llms.get("enabled") or not ask.get("enabled"):
    sys.exit("ERROR: llms.enabled and llms.ask.enabled must both be true in gendoc.yml")

site_url = (llms.get("site_url") or "").rstrip("/")
if not site_url:
    sys.exit("ERROR: llms.site_url is required")

pages_name = cf.get("pages_project_name") or "gendoc"
values = {
    "WORKER_NAME": ask.get("worker_name") or f"{pages_name}-ask",
    "COMPATIBILITY_DATE": cf.get("compatibility_date") or "2026-06-01",
    "LLMS_URL": f"{site_url}/llms.txt",
    "SITE_URL": site_url,
    "ALLOWED_ORIGINS": ",".join(ask.get("allowed_origins") or [site_url]),
    "BOT_NAME": ask.get("title") or f"{project.get('name', 'Docs')} Assistant",
    "PROVIDERS": ask.get("providers") or "gemini,openrouter",
    "GEMINI_MODEL": ask.get("gemini_model") or "gemini-2.5-flash",
    "OPENROUTER_MODELS": ask.get("openrouter_models")
        or "meta-llama/llama-4-scout:free,deepseek/deepseek-chat-v3-0324:free,qwen/qwen3-32b:free",
    "ENDPOINT": ask.get("endpoint") or "",
}
for key, value in values.items():
    print(f"{key}={shlex.quote(str(value))}")
PY
)"

# Substitute {{TOKENS}} into wrangler-ask.toml (all deployable files live
# under ask-ai/, so wrangler deploy runs from there and main=worker/ask.js
# resolves naturally).
GENERATED="$TEMPLATE_ROOT/ask-ai/wrangler-ask.toml"
sed -e "s|{{WORKER_NAME}}|$WORKER_NAME|g" \
    -e "s|{{COMPATIBILITY_DATE}}|$COMPATIBILITY_DATE|g" \
    -e "s|{{LLMS_URL}}|$LLMS_URL|g" \
    -e "s|{{SITE_URL}}|$SITE_URL|g" \
    -e "s|{{ALLOWED_ORIGINS}}|$ALLOWED_ORIGINS|g" \
    -e "s|{{BOT_NAME}}|$BOT_NAME|g" \
    -e "s|{{PROVIDERS}}|$PROVIDERS|g" \
    -e "s|{{GEMINI_MODEL}}|$GEMINI_MODEL|g" \
    -e "s|{{OPENROUTER_MODELS}}|$OPENROUTER_MODELS|g" \
    "$TEMPLATE_ROOT/ask-ai/wrangler-ask.toml.template" > "$GENERATED"

# When a custom endpoint is configured, append a [[routes]] section so
# traffic to that domain+path reaches this worker (shared-worker scenario).
if [ -n "$ENDPOINT" ]; then
    python3 -c "
import sys
from urllib.parse import urlparse
parsed = urlparse('$ENDPOINT')
host = parsed.hostname or ''
path = parsed.path.rstrip('/') or '/api/ask'
route_path = '/'.join(path.split('/')[:-1] + ['*'])
zone = '.'.join(host.split('.')[-2:])
with open('$GENERATED', 'a') as f:
    f.write(f'\n[[routes]]\npattern = \"{host}{route_path}\"\nzone_name = \"{zone}\"\n')
"
fi

echo "==> Deploying ask worker '$WORKER_NAME'"
DEPLOY_OUTPUT=$(cd "$TEMPLATE_ROOT/ask-ai" && CLOUDFLARE_API_TOKEN="$CF_API_TOKEN" CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID" \
  wrangler deploy --config "$GENERATED" 2>&1)
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

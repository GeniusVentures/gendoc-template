#!/usr/bin/env bash
# generate-ask-config.sh — generate ask-ai/wrangler-ask.toml from gendoc.yml.
#
# Run from the HOST PROJECT ROOT:
#   gendoc-template/scripts/generate-ask-config.sh [gendoc.yml] [--force]
#
# Skips generation if the output is already newer than both inputs.
# Pass --force to always regenerate.
# Called by both deploy-ask.sh and test-local.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="${1:-gendoc.yml}"

[ -f "$CONFIG" ] || { echo "ERROR: $CONFIG not found -- run from the host project root" >&2; exit 1; }

TEMPLATE="$TEMPLATE_ROOT/ask-ai/wrangler-ask.toml.template"
GENERATED="$TEMPLATE_ROOT/ask-ai/wrangler-ask.toml"
FORCE="${2:-}"

# Skip generation if the output is already newer than both inputs.
if [ "$FORCE" != "--force" ] && [ -f "$GENERATED" ] && [ -f "$TEMPLATE" ]; then
    if [ "$GENERATED" -nt "$CONFIG" ] && [ "$GENERATED" -nt "$TEMPLATE" ]; then
        echo "Config is up to date: $GENERATED"
        exit 0
    fi
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

# Substitute {{TOKENS}} into wrangler-ask.toml.template
if [ ! -f "$TEMPLATE" ]; then
    echo "ERROR: template not found at $TEMPLATE" >&2
    exit 1
fi

sed -e "s|{{WORKER_NAME}}|$WORKER_NAME|g" \
    -e "s|{{COMPATIBILITY_DATE}}|$COMPATIBILITY_DATE|g" \
    -e "s|{{LLMS_URL}}|$LLMS_URL|g" \
    -e "s|{{SITE_URL}}|$SITE_URL|g" \
    -e "s|{{ALLOWED_ORIGINS}}|$ALLOWED_ORIGINS|g" \
    -e "s|{{BOT_NAME}}|$BOT_NAME|g" \
    -e "s|{{PROVIDERS}}|$PROVIDERS|g" \
    -e "s|{{GEMINI_MODEL}}|$GEMINI_MODEL|g" \
    -e "s|{{OPENROUTER_MODELS}}|$OPENROUTER_MODELS|g" \
    "$TEMPLATE" > "$GENERATED"

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

# Write a small env file so callers (e.g. deploy-ask.sh) can source back
# the computed values without re-parsing gendoc.yml.
VARS_FILE="$TEMPLATE_ROOT/ask-ai/.generated-vars"
cat > "$VARS_FILE" <<EOF
WORKER_NAME=$WORKER_NAME
ENDPOINT=$ENDPOINT
GENERATED=$GENERATED
EOF

echo "Generated $GENERATED"

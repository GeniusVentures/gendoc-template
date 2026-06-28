#!/usr/bin/env bash
set -euo pipefail

# ── Locate template root and host project root ────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$HOST_ROOT/gendoc.yml"
WRANGLER_TPL="$TEMPLATE_ROOT/wrangler.toml.template"

# ── Validate prerequisites ────────────────────────────────────────────────────
if [ ! -f "$GENDOC_YML" ]; then
    echo "Error: gendoc.yml not found at $GENDOC_YML" >&2
    echo "       Create one by copying gendoc-template/gendoc.yml.example and filling in your project values." >&2
    exit 1
fi

if [ ! -f "$WRANGLER_TPL" ]; then
    echo "Error: wrangler.toml.template not found at $WRANGLER_TPL" >&2
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

if [ -z "${CF_API_TOKEN:-}" ]; then
    echo "Error: CF_API_TOKEN environment variable is not set." >&2
    echo "       Set it with: export CF_API_TOKEN=<your-token>" >&2
    exit 1
fi

if [ -z "${CF_ACCOUNT_ID:-}" ]; then
    echo "Error: CF_ACCOUNT_ID environment variable is not set." >&2
    echo "       Set it with: export CF_ACCOUNT_ID=<your-account-id>" >&2
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
PAGES_PROJECT_NAME=$(read_yaml "deploy.cloudflare.pages_project_name")
COMPATIBILITY_DATE=$(read_yaml "deploy.cloudflare.compatibility_date")
SITE_DIR=$(read_yaml "mkdocs.site_dir")

# ── Validate required config values ───────────────────────────────────────────
if [ -z "$PAGES_PROJECT_NAME" ]; then
    echo "Error: deploy.cloudflare.pages_project_name is required in gendoc.yml" >&2
    exit 1
fi

if [ -z "$COMPATIBILITY_DATE" ]; then
    echo "Error: deploy.cloudflare.compatibility_date is required in gendoc.yml" >&2
    exit 1
fi

if [ -z "$SITE_DIR" ]; then
    SITE_DIR="site"
fi

SITE_DIR_ABS="$HOST_ROOT/$SITE_DIR"

# ── Informational output ──────────────────────────────────────────────────────
echo "  Project:        ${PROJECT_NAME:-(unnamed)}"
echo "  Pages project:  $PAGES_PROJECT_NAME"
echo "  Site directory: $SITE_DIR_ABS"

# ── Generate wrangler.toml from template ──────────────────────────────────────
echo ""
echo "Generating wrangler.toml from template..."

WRANGLER_OUT="$TEMPLATE_ROOT/wrangler.toml"

python3 -c "
import sys
with open(sys.argv[1], 'r') as f:
    content = f.read()
content = content.replace('{{PAGES_PROJECT_NAME}}', sys.argv[2])
content = content.replace('{{COMPATIBILITY_DATE}}', sys.argv[3])
content = content.replace('{{SITE_DIR}}', sys.argv[4])
with open(sys.argv[5], 'w') as f:
    f.write(content)
" "$WRANGLER_TPL" "$PAGES_PROJECT_NAME" "$COMPATIBILITY_DATE" "$SITE_DIR" "$WRANGLER_OUT"

echo "  wrangler.toml written to $WRANGLER_OUT"

# ── Check site directory exists ───────────────────────────────────────────────
if [ ! -d "$SITE_DIR_ABS" ]; then
    echo ""
    echo "Warning: Site directory not found at $SITE_DIR_ABS" >&2
    echo "         Run build.sh first to generate the static site." >&2
fi

# ── Deploy to Cloudflare Pages ────────────────────────────────────────────────
echo ""
echo "Deploying to Cloudflare Pages..."

cd "$TEMPLATE_ROOT"

if CF_API_TOKEN="$CF_API_TOKEN" CF_ACCOUNT_ID="$CF_ACCOUNT_ID" wrangler pages deploy "$SITE_DIR_ABS" --project-name "$PAGES_PROJECT_NAME"; then
    echo ""
    echo "=============================================="
    echo "  Deployment complete"
    echo "  Project: $PAGES_PROJECT_NAME"
    echo "  URL:     https://$PAGES_PROJECT_NAME.pages.dev"
    echo "=============================================="
else
    exit_code=$?
    echo "Error: wrangler pages deploy failed with exit code $exit_code" >&2
    exit $exit_code
fi

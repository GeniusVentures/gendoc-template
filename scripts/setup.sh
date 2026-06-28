#!/usr/bin/env bash
set -euo pipefail

# ── Locate paths ─────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"
GENDOC_YML="$HOST_ROOT/gendoc.yml"

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
print(str(value) if value is not None else '', end='')
" "$GENDOC_YML" "$1"
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

# ── Set up custom domain ─────────────────────────────────────────────────────
if [ -n "$CUSTOM_DOMAIN" ]; then
    echo ""
    echo "Setting up custom domain '$CUSTOM_DOMAIN'..."

    if wrangler pages project list domains "$PAGES_PROJECT_NAME" 2>/dev/null | grep -q "$CUSTOM_DOMAIN"; then
        echo "  Domain '$CUSTOM_DOMAIN' already configured — skipping."
    else
        wrangler pages project domains add "$PAGES_PROJECT_NAME" "$CUSTOM_DOMAIN"
        echo ""
        echo "  Domain '$CUSTOM_DOMAIN' added to '$PAGES_PROJECT_NAME'."
        echo "  Add the CNAME record shown above to your DNS provider."
        echo "  Cloudflare will provision the SSL certificate automatically."
    fi
fi

# ── Generate wrangler.toml from template ─────────────────────────────────────
SITE_DIR="${SITE_DIR:-site}"
SITE_DIR_ABS="$HOST_ROOT/$SITE_DIR"
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

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "=============================================="
echo "  Setup complete"
echo "  Project:   $PAGES_PROJECT_NAME"
echo "  Pages URL: https://$PAGES_PROJECT_NAME.pages.dev"
if [ -n "$CUSTOM_DOMAIN" ]; then
    echo "  Custom:    https://$CUSTOM_DOMAIN"
fi
echo ""
echo "  Next: gendoc-template/scripts/build.sh"
echo "        gendoc-template/scripts/deploy.sh"
echo "=============================================="

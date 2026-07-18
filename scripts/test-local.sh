#!/usr/bin/env bash
# test-local.sh -- run the ask worker and static site locally for development.
#
# Step 1 (one-time, manual): create .dev.vars in the project root with your API keys:
#   cat > .dev.vars <<'EOF'
#   GEMINI_API_KEY=your-gemini-key-here
#   OPENROUTER_API_KEY=your-openrouter-key-here
#   EOF
#
# Then just run this script from the project root.  Press Ctrl-C to stop
# everything.  The widget auto-detects localhost and uses the local worker —
# no file patching needed.
#
#   gendoc-template/scripts/test-local.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOST_ROOT="$(cd "$TEMPLATE_ROOT/.." && pwd)"

# ── Activate Python virtual environment ────────────────────────────────────────
VENV="$TEMPLATE_ROOT/.venv"
if [ -d "$VENV" ]; then
    export PATH="$VENV/bin:$PATH"
fi
SITE_DIR="$TEMPLATE_ROOT/site"
# If the build output ended up in the host root (pre-build.sh fix), use that.
HOST_SITE="$HOST_ROOT/site"
if [ -f "$HOST_SITE/index.html" ] && [ ! -f "$SITE_DIR/index.html" ]; then
    SITE_DIR="$HOST_SITE"
fi
WORKER_DIR="$TEMPLATE_ROOT/ask-ai"
WRANGLER_CONFIG="$TEMPLATE_ROOT/../wrangler-ask.toml"
DEV_VARS="$HOST_ROOT/.dev.vars"

LOCAL_CONFIG="$SITE_DIR/ask-config.local.json"
LOCAL_CONFIG_GZ="$SITE_DIR/ask-config.local.json.gz"

WORKER_PORT="${ASK_LOCAL_PORT:-8787}"
SITE_PORT="${ASK_SITE_PORT:-8000}"
WORKER_URL="http://localhost:$WORKER_PORT/api/ask?debug=true"
SITE_URL="http://localhost:$SITE_PORT"

PID_WRANGLER=""
PID_SERVER=""

# ── helpers ──────────────────────────────────────────────────────────────────
free_port() {
    # Kill whatever is listening on $1 so we can bind to it.
    local pid
    pid=$(lsof -ti ":$1" 2>/dev/null || true)
    if [ -n "$pid" ]; then
        echo "Killing stale process on port $1 (pid $pid)..."
        kill $pid 2>/dev/null || true
        sleep 1
    fi
}

# ── cleanup ──────────────────────────────────────────────────────────────────
cleanup() {
    echo ""
    echo "Shutting down..."
    # Kill tracked PIDs and their children first.
    [ -n "$PID_SERVER" ]   && kill "$PID_SERVER"   2>/dev/null || true
    [ -n "$PID_WRANGLER" ] && kill "$PID_WRANGLER" 2>/dev/null || true
    sleep 1
    # Force-kill anything still holding the ports (catches child processes).
    lsof -ti ":$SITE_PORT"   2>/dev/null | xargs kill -9 2>/dev/null || true
    lsof -ti ":$WORKER_PORT" 2>/dev/null | xargs kill -9 2>/dev/null || true
    wait 2>/dev/null || true

    # Remove local config files created by this script.
    rm -f "${LOCAL_CONFIG:-}" "${LOCAL_CONFIG_GZ:-}"
    echo "Done."
}
trap cleanup EXIT INT TERM

# ── prerequisites ────────────────────────────────────────────────────────────
command -v wrangler >/dev/null 2>&1 || { echo "ERROR: wrangler not found (npm install -g wrangler)" >&2; exit 1; }
command -v python3  >/dev/null 2>&1 || { echo "ERROR: python3 not found" >&2; exit 1; }

bash "$SCRIPT_DIR/generate-ask-config.sh"
if [ ! -f "$WRANGLER_CONFIG" ]; then
    echo "ERROR: failed to generate $WRANGLER_CONFIG" >&2
    exit 1
fi

# Build the search vocabulary so the worker has typo correction locally.
VOCAB_BUILDER="$SCRIPT_DIR/build-vocab.py"
SEARCH_INDEX="$SITE_DIR/search/search_index.json"
VOCAB_OUT="$SITE_DIR/data/search-vocab.json"
if [ -f "$SEARCH_INDEX" ] && [ -f "$VOCAB_BUILDER" ]; then
    mkdir -p "$(dirname "$VOCAB_OUT")"
    python3 "$VOCAB_BUILDER" "$SEARCH_INDEX" "$VOCAB_OUT" || true
fi

# Ensure worker npm dependencies are installed (TypeScript, Wrangler types).
if [ ! -d "$WORKER_DIR/worker/node_modules" ]; then
    echo "Installing worker npm dependencies..."
    (cd "$WORKER_DIR/worker" && npm install)
fi
if [ ! -f "$DEV_VARS" ]; then
    echo "WARNING: $DEV_VARS not found — worker won't have API keys."
    echo "         Create it with your GEMINI_API_KEY and OPENROUTER_API_KEY"
    echo "         (see comments at the top of this script)."
    echo ""
fi

# ── generate ask-config.local.json → local worker ─────────────────────────────
# The widget looks for this file first on localhost; falls back to
# ask-config.json when absent (e.g. testing against remote worker).
# ── Read gendoc.yml values (single Python call) ────────────────────────────────
eval "$(python3 "$SCRIPT_DIR/read-yaml.py" "$HOST_ROOT/gendoc.yml" --batch \
    "llms.ask.title=ASK_TITLE" \
    "llms.ask.placeholder=ASK_PLACEHOLDER" \
)"
ASK_TITLE="${ASK_TITLE:-Ask}"
ASK_PLACEHOLDER="${ASK_PLACEHOLDER:-Ask a question...}"

cat > "$LOCAL_CONFIG" <<EOF
{
  "enabled": true,
  "endpoint": "$WORKER_URL",
  "title": "$ASK_TITLE",
  "placeholder": "$ASK_PLACEHOLDER",
  "llms_full_url": "$SITE_URL/llms-full.txt"
}
EOF
gzip -fk "$LOCAL_CONFIG"  # for fetch-gzip.js wrapper
rm "$LOCAL_CONFIG"        # widget loads .json.gz via fetch-gzip.js
echo "Generated $LOCAL_CONFIG_GZ (widget → $WORKER_URL)"

# ── start wrangler dev (background) ───────────────────────────────────────────
echo ""
echo "Starting local worker on $WORKER_URL ..."
free_port "$WORKER_PORT"
cd "$WORKER_DIR" && wrangler dev \
    --config "$WRANGLER_CONFIG" \
    --var "ALLOWED_ORIGINS:$SITE_URL,$WORKER_URL" \
    --var "LLMS_URL:$SITE_URL/llms.txt" \
    --var "SITE_URL:$SITE_URL" \
    --port "$WORKER_PORT" \
    > /tmp/ask-worker.log 2>&1 &
PID_WRANGLER=$!

# Wait for wrangler to be ready.
for i in $(seq 1 30); do
    if curl -s -o /dev/null "http://localhost:$WORKER_PORT/api/ask" 2>/dev/null; then
        # 404 on GET is fine — means the worker is listening
        echo "Worker ready (pid $PID_WRANGLER)"
        break
    fi
    if [ "$i" -eq 30 ]; then
        echo "ERROR: worker failed to start after 30s. Log:"
        tail -20 /tmp/ask-worker.log
        exit 1
    fi
    sleep 1
done

# ── start static server (foreground) ─────────────────────────────────────────
echo ""
echo "Serving site at $SITE_URL"
echo "Press Ctrl-C to stop."
echo "------------------------------------------------------------"
free_port "$SITE_PORT"
cd "$SITE_DIR" && python3 -m http.server "$SITE_PORT" --protocol HTTP/1.1 &
PID_SERVER=$!

wait

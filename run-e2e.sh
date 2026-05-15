#!/bin/bash
# ===========================================================================
# Run E2E tests inside WSL with real everything.
# Usage: wsl -d Debian -u hiram -- bash /mnt/c/Users/maelh/Desktop/HIRAM/run-e2e.sh [test-number]
# ===========================================================================

set -e

PROJECT="/mnt/c/Users/maelh/Desktop/HIRAM"
LINUX_ROOT="$HOME/hiram-e2e"
export PATH="$HOME/node22/bin:$PATH"

# Bootstrap Node if missing.
if ! command -v node &>/dev/null; then
  echo "Installing Node 22..."
  mkdir -p "$HOME/node22"
  curl -fsSL https://nodejs.org/dist/v22.12.0/node-v22.12.0-linux-x64.tar.gz -o /tmp/node.tar.gz
  tar -xzf /tmp/node.tar.gz -C "$HOME/node22" --strip-components=1
fi

echo "Node: $(node --version)"

# Bootstrap gh CLI if missing.
if ! command -v gh &>/dev/null; then
  echo "Installing gh CLI..."
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq >/dev/null 2>&1
  sudo apt-get install -y -qq gh >/dev/null 2>&1
fi
echo "gh: $(gh --version 2>&1 | head -1)"

# Bootstrap gcloud SDK if missing.
if ! command -v gcloud &>/dev/null; then
  echo "Installing gcloud SDK..."
  curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar -xz -C /opt 2>/dev/null
  /opt/google-cloud-sdk/install.sh --quiet --path-update false >/dev/null 2>&1
  sudo ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
  sudo ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil
fi
echo "gcloud: $(gcloud --version 2>&1 | head -1)"

# Bootstrap cloudflared if missing.
if ! command -v cloudflared &>/dev/null; then
  echo "Installing cloudflared..."
  sudo curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
  sudo chmod +x /usr/local/bin/cloudflared
fi
echo "cloudflared: $(cloudflared --version 2>&1 | head -1)"

# Copy project to Linux filesystem (native SQLite).
echo "Preparing Linux project copy (clean slate)..."
rm -rf "$LINUX_ROOT"
mkdir -p "$LINUX_ROOT"
cp -r "$PROJECT/package.json" "$PROJECT/package-lock.json" "$PROJECT/dist" "$PROJECT/src" "$PROJECT/tests" "$PROJECT/vitest.config.e2e.ts" "$LINUX_ROOT/"

cd "$LINUX_ROOT"
npm ci --ignore-scripts --omit=dev >/dev/null 2>&1
# Re-add vitest (dev dep needed for tests).
npm install vitest >/dev/null 2>&1
npm rebuild better-sqlite3 >/dev/null 2>&1

# Load real API keys.
set -a
source "$PROJECT/.env" 2>/dev/null || true
set +a

# Also load from the mock-boot .env if it has VAULT_ vars.
if [ -f "$HOME/hiram-mock/.env" ]; then
  set -a
  source "$HOME/hiram-mock/.env"
  set +a
fi

# Export all VAULT_ vars from the main .env too.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
export HIRAM_MASTER_KEY="${HIRAM_MASTER_KEY:-h1r4m-e2e-test-key-2026}"

# Ensure transcripts directory exists.
mkdir -p "$LINUX_ROOT/test-transcripts"

# Run the specified test or all.
TEST_FILTER="${1:-01}"
echo ""
echo "============================================="
echo "  HIRAM E2E Test ${TEST_FILTER}"
echo "  $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "============================================="
echo ""

npx vitest run --config vitest.config.e2e.ts --reporter=verbose tests/e2e/${TEST_FILTER}*.test.ts 2>&1 | tee "$LINUX_ROOT/test-transcripts/e2e-${TEST_FILTER}-$(date +%Y%m%d-%H%M%S).log"

echo ""
echo "Transcripts saved to: $LINUX_ROOT/test-transcripts/"

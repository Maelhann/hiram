#!/usr/bin/env bash
# ===========================================================================
#
#   H I R A M   —   Autonomous Agent Daemon
#
#   Self-checking startup script. Verifies all dependencies are present,
#   installs anything missing, then boots the daemon.
#   Designed to work on a fresh Ubuntu/Debian server with nothing installed.
#
# ===========================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Colours & formatting
# ---------------------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

ok()   { echo -e "  ${GREEN}✓${RESET} $1"; }
warn() { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1"; }
step() { echo -e "\n${CYAN}${BOLD}▸ $1${RESET}"; }
info() { echo -e "  ${DIM}$1${RESET}"; }

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HIRAM_ROOT="${HIRAM_ROOT:-/opt/hiram}"
NODE_MIN_VERSION=22
REQUIRED_PKGS=(curl ca-certificates gnupg git gh redis-server libsecret-1-dev build-essential docker.io)

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                                                          ║${RESET}"
echo -e "${BOLD}║   ${CYAN}H I R A M${RESET}${BOLD}   —   Autonomous Agent Daemon              ║${RESET}"
echo -e "${BOLD}║                                                          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  ${DIM}Root:    ${HIRAM_ROOT}${RESET}"
echo -e "  ${DIM}Date:    $(date -u '+%Y-%m-%d %H:%M:%S UTC')${RESET}"
echo -e "  ${DIM}Host:    $(hostname)${RESET}"

# ---------------------------------------------------------------------------
# 1. System packages (must come first — curl is needed for everything else)
# ---------------------------------------------------------------------------
step "System packages"

# Ensure apt is usable.
APT_UPDATED=false
ensure_apt() {
  if [ "$APT_UPDATED" = false ]; then
    sudo apt-get update -qq >/dev/null 2>&1
    APT_UPDATED=true
  fi
}

# Add GitHub CLI apt repo if gh not already installed.
if ! command -v gh &>/dev/null && [ ! -f /usr/share/keyrings/githubcli-archive-keyring.gpg ]; then
  ensure_apt
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /usr/share/keyrings/githubcli-archive-keyring.gpg >/dev/null
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  APT_UPDATED=false  # force re-update after adding repo
fi

MISSING_PKGS=()
for pkg in "${REQUIRED_PKGS[@]}"; do
  if dpkg -s "$pkg" &>/dev/null 2>&1; then
    ok "$pkg"
  else
    MISSING_PKGS+=("$pkg")
  fi
done

if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
  info "Installing ${MISSING_PKGS[*]}..."
  ensure_apt
  sudo apt-get install -y -qq "${MISSING_PKGS[@]}" >/dev/null 2>&1
  for pkg in "${MISSING_PKGS[@]}"; do
    ok "$pkg installed"
  done
fi

# ---------------------------------------------------------------------------
# 2. Node.js
# ---------------------------------------------------------------------------
step "Node.js (>= ${NODE_MIN_VERSION})"

NEED_NODE=false
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge "$NODE_MIN_VERSION" ]; then
    ok "node $(node --version)"
  else
    NEED_NODE=true
    warn "node $(node --version) is too old"
  fi
else
  NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
  info "Installing Node ${NODE_MIN_VERSION} via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MIN_VERSION}.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y -qq nodejs >/dev/null 2>&1
  ok "node $(node --version) installed"
fi

ok "npm $(npm --version)"

# ---------------------------------------------------------------------------
# 3. Redis
# ---------------------------------------------------------------------------
step "Redis"

if redis-cli ping &>/dev/null 2>&1; then
  ok "Redis is running ($(redis-cli info server 2>/dev/null | grep redis_version | cut -d: -f2 | tr -d '\r'))"
else
  info "Starting Redis..."
  sudo systemctl start redis-server 2>/dev/null || sudo redis-server --daemonize yes 2>/dev/null || true
  sleep 0.5
  if redis-cli ping &>/dev/null 2>&1; then
    ok "Redis started"
  else
    warn "Redis not available — daemon will run without it (non-critical)"
  fi
fi

# ---------------------------------------------------------------------------
# 3b. Docker
# ---------------------------------------------------------------------------
step "Docker"

if docker info &>/dev/null 2>&1; then
  ok "Docker is running ($(docker --version 2>&1 | awk '{print $3}' | tr -d ','))"
else
  info "Starting Docker..."
  sudo systemctl start docker 2>/dev/null || sudo dockerd --host=unix:///var/run/docker.sock &>/dev/null &
  sleep 1
  if docker info &>/dev/null 2>&1; then
    ok "Docker started"
  else
    warn "Docker not available — container operations will fail"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Cloudflared (Cloudflare Tunnel)
# ---------------------------------------------------------------------------
step "Cloudflare Tunnel"

if command -v cloudflared &>/dev/null; then
  ok "cloudflared $(cloudflared --version 2>&1 | head -1 | awk '{print $3}')"
else
  info "Installing cloudflared..."
  ARCH=$(dpkg --print-architecture)
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb" -o /tmp/cloudflared.deb
  sudo dpkg -i /tmp/cloudflared.deb >/dev/null 2>&1
  rm -f /tmp/cloudflared.deb
  if command -v cloudflared &>/dev/null; then
    ok "cloudflared $(cloudflared --version 2>&1 | head -1 | awk '{print $3}') installed"
  else
    warn "cloudflared install failed — tunnel will be unavailable"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Project files
# ---------------------------------------------------------------------------
step "Project files"

if [ -f "$HIRAM_ROOT/dist/daemon.js" ]; then
  ok "dist/daemon.js"
else
  fail "dist/daemon.js not found at $HIRAM_ROOT"
  echo -e "\n  ${RED}Deploy the project first:${RESET}"
  echo -e "  ${DIM}  npm run build${RESET}"
  echo -e "  ${DIM}  cp -r dist package.json package-lock.json node_modules src $HIRAM_ROOT/${RESET}"
  exit 1
fi

if [ -d "$HIRAM_ROOT/node_modules" ]; then
  ok "node_modules/"
else
  info "Installing dependencies..."
  cd "$HIRAM_ROOT"
  npm ci --omit=dev >/dev/null 2>&1
  ok "node_modules/ installed"
fi

if [ -d "$HIRAM_ROOT/src/tools/seeds" ]; then
  ok "src/tools/seeds/ (custom plugin sources)"
else
  warn "src/tools/seeds/ missing — custom plugins won't seed"
fi

# ---------------------------------------------------------------------------
# 6. Environment
# ---------------------------------------------------------------------------
step "Environment"

if [ -f "$HIRAM_ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$HIRAM_ROOT/.env"
  set +a
  ok ".env loaded"
else
  warn ".env not found at $HIRAM_ROOT/.env"
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "ANTHROPIC_API_KEY (${#ANTHROPIC_API_KEY} chars)"
else
  fail "ANTHROPIC_API_KEY not set"
  echo -e "\n  ${RED}Set ANTHROPIC_API_KEY in $HIRAM_ROOT/.env${RESET}"
  exit 1
fi

if [ -n "${HIRAM_MASTER_KEY:-}" ]; then
  ok "HIRAM_MASTER_KEY"
else
  fail "HIRAM_MASTER_KEY not set"
  echo -e "\n  ${RED}Set HIRAM_MASTER_KEY in $HIRAM_ROOT/.env${RESET}"
  exit 1
fi

# Count VAULT_ vars to show how many secrets will be seeded.
VAULT_COUNT=$(env | grep -c '^VAULT_' 2>/dev/null || echo 0)
if [ "$VAULT_COUNT" -gt 0 ]; then
  ok "${VAULT_COUNT} vault secrets ready to seed"
else
  warn "No VAULT_* env vars — vault will be empty on first boot"
fi

export WEBHOOK_PORT="${WEBHOOK_PORT:-7401}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export SQLITE_PATH="${SQLITE_PATH:-$HIRAM_ROOT/data/hiram.db}"
export SOCKET_PATH="${SOCKET_PATH:-/var/run/hiram/hiram.sock}"
export TCP_PORT="${TCP_PORT:-7400}"
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-$HIRAM_ROOT}"
export TOOLS_DIR="${TOOLS_DIR:-$HIRAM_ROOT/tools}"
export BACKUP_DIR="${BACKUP_DIR:-$HIRAM_ROOT/backups}"

info "Webhook port:    $WEBHOOK_PORT"
info "SQLite:          $SQLITE_PATH"
info "Workspace:       $WORKSPACE_ROOT"

# ---------------------------------------------------------------------------
# 7. Directories
# ---------------------------------------------------------------------------
step "Directories"

for dir in "$HIRAM_ROOT/data" "$HIRAM_ROOT/tools" "$HIRAM_ROOT/backups" "$(dirname "$SOCKET_PATH")"; do
  if [ -d "$dir" ]; then
    ok "$dir"
  else
    mkdir -p "$dir" 2>/dev/null || sudo mkdir -p "$dir"
    ok "$dir (created)"
  fi
done

step "Playwright browsers"

# ---------------------------------------------------------------------------
# 8b. HubSpot CLI
# ---------------------------------------------------------------------------
step "HubSpot CLI"

if command -v hs &>/dev/null; then
  ok "hs $(hs --version 2>&1 | head -1)"
else
  info "Installing HubSpot CLI..."
  npm install -g @hubspot/cli >/dev/null 2>&1
  if command -v hs &>/dev/null; then
    ok "hs $(hs --version 2>&1 | head -1) installed"
  else
    warn "HubSpot CLI install failed — HubSpot webhooks will need manual setup"
  fi
fi

# ---------------------------------------------------------------------------
# 9. Playwright browsers
# ---------------------------------------------------------------------------
if npx playwright install --dry-run chromium &>/dev/null 2>&1; then
  ok "Chromium available"
else
  info "Installing Chromium for Playwright..."
  npx -y playwright install --with-deps chromium >/dev/null 2>&1 && ok "Chromium installed" || warn "Chromium install skipped"
fi

# ---------------------------------------------------------------------------
# Boot
# ---------------------------------------------------------------------------
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║                                                          ║${RESET}"
echo -e "${BOLD}║   ${GREEN}Pre-flight complete. Starting daemon...${RESET}${BOLD}               ║${RESET}"
echo -e "${BOLD}║                                                          ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""

cd "$HIRAM_ROOT"
exec node "$HIRAM_ROOT/dist/daemon.js"

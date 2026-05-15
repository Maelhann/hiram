#!/usr/bin/env bash
set -euo pipefail

# HIRAM server setup script for Ubuntu 22.04+
# Run as root or with sudo

echo "=== HIRAM Server Setup ==="

# 1. System packages
echo "[1/6] Installing system packages..."
apt update
apt install -y build-essential curl

# 2. Node.js 22 LTS
echo "[2/6] Installing Node.js 22..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi
echo "Node.js $(node -v) installed."

# 3. Redis with AOF persistence
echo "[3/6] Installing and configuring Redis..."
apt install -y redis-server
sed -i 's/^appendonly no$/appendonly yes/' /etc/redis/redis.conf
systemctl restart redis-server
systemctl enable redis-server
echo "Redis configured with AOF persistence."

# 4. Playwright browser binaries (for the playwright MCP plugin)
echo "[4/8] Installing Playwright Chromium..."
npx playwright install --with-deps chromium

# 5. Claude Code CLI (for developer-tools plugin)
echo "[5/8] Installing Claude Code CLI..."
npm install -g @anthropic-ai/claude-code

# 5b. GCP + Firebase CLI (standard stack for all services)
echo "Installing Google Cloud CLI..."
if ! command -v gcloud &> /dev/null; then
  curl -fsSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz | tar -xz -C /opt
  /opt/google-cloud-sdk/install.sh --quiet --path-update true
  ln -sf /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud
  ln -sf /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil
fi
echo "Installing Firebase CLI..."
npm install -g firebase-tools

# 6. Docker (for docker MCP plugin)
echo "[6/8] Installing Docker..."
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# 7. Create hiram user
echo "[7/8] Creating hiram user..."
if ! id hiram &>/dev/null; then
  useradd -m -s /bin/bash hiram
  usermod -aG sudo hiram
  usermod -aG docker hiram
fi

# 8. Deploy application
echo "[8/8] Setting up application directory..."
mkdir -p /opt/hiram/data
mkdir -p /opt/hiram/tools
mkdir -p /opt/hiram/backups
mkdir -p /opt/hiram/dev
mkdir -p /opt/hiram/content
mkdir -p /opt/hiram/ops
mkdir -p /opt/hiram/research
mkdir -p /opt/hiram/scratch
mkdir -p /var/run/hiram

# Copy files (assumes this script is run from the repo root)
cp -r dist/ /opt/hiram/dist/
cp -r node_modules/ /opt/hiram/node_modules/
cp package.json /opt/hiram/
if [ -f .env ]; then
  cp .env /opt/hiram/.env
else
  echo "WARNING: No .env file found. Copy .env.example to .env and fill in values."
  cp .env.example /opt/hiram/.env.example
fi

chown -R hiram:hiram /opt/hiram
chown -R hiram:hiram /var/run/hiram

# Install and enable systemd service
cp deploy/hiram.service /etc/systemd/system/hiram.service
systemctl daemon-reload
systemctl enable hiram
echo "Service installed. Start with: systemctl start hiram"

# 9. Prometheus — metrics scraping
echo "Installing Prometheus..."
if ! command -v prometheus &> /dev/null; then
  apt install -y prometheus
fi
cp deploy/prometheus.yml /etc/prometheus/prometheus.yml
systemctl restart prometheus
systemctl enable prometheus

# 10. Grafana — dashboards
echo "Installing Grafana..."
if ! command -v grafana-server &> /dev/null; then
  apt install -y apt-transport-https software-properties-common
  wget -q -O /usr/share/keyrings/grafana.key https://apt.grafana.com/gpg.key
  echo "deb [signed-by=/usr/share/keyrings/grafana.key] https://apt.grafana.com stable main" | tee /etc/apt/sources.list.d/grafana.list
  apt update && apt install -y grafana
fi

# Provision datasource and dashboard.
mkdir -p /etc/grafana/provisioning/datasources
mkdir -p /etc/grafana/provisioning/dashboards
mkdir -p /var/lib/grafana/dashboards
cp deploy/grafana-provisioning-datasource.yml /etc/grafana/provisioning/datasources/hiram.yml
cp deploy/grafana-provisioning-dashboard.yml /etc/grafana/provisioning/dashboards/hiram.yml
cp deploy/grafana-dashboard.json /var/lib/grafana/dashboards/hiram.json
chown -R grafana:grafana /var/lib/grafana/dashboards
systemctl restart grafana-server
systemctl enable grafana-server

echo ""
echo "=== Setup complete ==="
echo "Next steps:"
echo "  1. Edit /opt/hiram/.env with your ANTHROPIC_API_KEY and HIRAM_MASTER_KEY"
echo "  2. systemctl start hiram"
echo "  3. journalctl -u hiram -f"
echo ""
echo "Monitoring:"
echo "  - Prometheus: http://localhost:9090"
echo "  - Grafana:    http://localhost:3000 (admin/admin)"
echo "  - Metrics:    http://localhost:7401/metrics/prometheus"

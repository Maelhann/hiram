#!/usr/bin/env bash
# ===========================================================================
# Deploy the webhook-relay Cloud Function to GCP.
#
# Prerequisites:
#   - gcloud CLI authenticated with YOUR_GCP_PROJECT project
#   - Environment variables set (or pass via --set-env-vars)
#
# Usage:
#   HIRAM_WEBHOOK_URL=https://hiram.yourdomain.com \
#   WEBHOOK_RELAY_SECRET=<secret> \
#   STRIPE_WEBHOOK_SECRET=<secret> \
#   CLOUDFLARE_WEBHOOK_TOKEN=<token> \
#   HUBSPOT_CLIENT_SECRET=<secret> \
#   ./deploy.sh
# ===========================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building webhook-relay..."
npm ci
npm run build

echo "Deploying to GCP Cloud Functions (2nd gen)..."
gcloud functions deploy webhook-relay \
  --gen2 \
  --runtime=nodejs22 \
  --region=europe-west1 \
  --trigger-http \
  --allow-unauthenticated \
  --entry-point=webhookRelay \
  --project=YOUR_GCP_PROJECT \
  --service-account=YOUR_SERVICE_ACCOUNT@YOUR_GCP_PROJECT.iam.gserviceaccount.com \
  --memory=256Mi \
  --timeout=30s \
  --source=dist/ \
  --set-env-vars="HIRAM_WEBHOOK_URL=${HIRAM_WEBHOOK_URL},WEBHOOK_RELAY_SECRET=${WEBHOOK_RELAY_SECRET},STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-},CLOUDFLARE_WEBHOOK_TOKEN=${CLOUDFLARE_WEBHOOK_TOKEN:-},HUBSPOT_CLIENT_SECRET=${HUBSPOT_CLIENT_SECRET:-}"

echo ""
echo "Deployed. Function URL:"
gcloud functions describe webhook-relay \
  --gen2 \
  --region=europe-west1 \
  --project=YOUR_GCP_PROJECT \
  --format='value(serviceConfig.uri)'

echo ""
echo "Configure external services to POST webhooks to:"
echo "  Stripe:     <function-url>/relay/stripe"
echo "  Cloudflare: <function-url>/relay/cloudflare"
echo "  HubSpot:    <function-url>/relay/hubspot"
echo "  Instantly:  <function-url>/relay/instantly"

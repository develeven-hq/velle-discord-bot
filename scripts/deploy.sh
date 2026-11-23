#!/usr/bin/env bash
# NOTE: The copy in /usr/local/bin/deploy-velle-bot is the one that runs on the server.
set -euo pipefail

cd /opt/velle/app

APP_DIR="/opt/velle/app"
SERVICE="velle-bot"
APP_USER="velle"

echo "🚀 [1/4] Pulling latest changes as ${APP_USER}..."
sudo -u "${APP_USER}" -H git -C "${APP_DIR}" fetch origin main
sudo -u "${APP_USER}" -H git -C "${APP_DIR}" reset --hard origin/main

echo "📦 [2/4] Installing dependencies with npm ci as ${APP_USER}..."
sudo -u "${APP_USER}" -H npm --prefix "${APP_DIR}" ci

echo "🔄 [3/4] Restarting ${SERVICE} service..."
systemctl restart "${SERVICE}"

echo "⏳ Waiting 5 seconds to verify service stability..."
sleep 5

echo "✅ [4/4] Verifying ${SERVICE} status..."
systemctl is-active --quiet "${SERVICE}"
echo "🎉 ${SERVICE} successfully redeployed and running!"

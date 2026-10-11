#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

rm -f /etc/apt/sources.list.d/caddy-stable.list /usr/share/keyrings/caddy-stable-archive-keyring.gpg

if ! command -v caddy >/dev/null 2>&1; then
  tmp=$(mktemp)
  curl -fsSL -o "$tmp" https://api.github.com/repos/caddyserver/caddy/releases/latest
  ver=$(grep -m1 '"tag_name"' "$tmp" | cut -d'"' -f4)
  rm -f "$tmp"
  echo "Installing Caddy $ver"
  curl -fsSL -o /tmp/caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/${ver}/caddy_${ver#v}_linux_amd64.tar.gz"
  tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy
  chmod 755 /usr/local/bin/caddy
  rm -f /tmp/caddy.tar.gz
fi
caddy version

id df >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash df
mkdir -p /opt/dietfantasy /var/lib/dietfantasy /etc/dietfantasy
tar -xzf /tmp/df-portal.tgz -C /opt/dietfantasy

umask 077
cat /tmp/.env /tmp/portal-extra.env > /etc/dietfantasy/secrets.env
chown root:df /etc/dietfantasy/secrets.env
chmod 640 /etc/dietfantasy/secrets.env
rm -f /tmp/.env /tmp/portal-extra.env /tmp/df-portal.tgz

chown -R df:df /opt/dietfantasy /var/lib/dietfantasy

cd /opt/dietfantasy
sudo -u df env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
npx playwright install-deps chromium
sudo -u df env PLAYWRIGHT_BROWSERS_PATH=/opt/dietfantasy/playwright-browsers npx playwright install chromium
chown -R df:df /opt/dietfantasy/playwright-browsers

cat > /etc/systemd/system/dietfantasy.service <<'UNIT'
[Unit]
Description=Diet Fantasy billing portal
After=network.target

[Service]
Type=simple
User=df
Group=df
WorkingDirectory=/opt/dietfantasy
Environment=PORTAL_MODE=1
Environment=PORT=3500
Environment=PORTAL_BIND=127.0.0.1
Environment=PORTAL_DATA_DIR=/var/lib/dietfantasy
Environment=DOTENV_PATH=/etc/dietfantasy/secrets.env
Environment=NODE_ENV=production
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/dietfantasy/playwright-browsers
Environment=USE_SYSTEM_CHROME=false
Environment=PORTAL_MAX_JOBS=2
Environment=PORTAL_MAX_BROWSERS=4
EnvironmentFile=-/etc/dietfantasy/secrets.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

mkdir -p /etc/caddy
cat > /etc/caddy/Caddyfile <<'CADDY'
dfbilling.poel.ai {
	reverse_proxy 127.0.0.1:3500
}
CADDY

cat > /etc/systemd/system/caddy.service <<'CADDYUNIT'
[Unit]
Description=Caddy
After=network.target

[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --environ
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
User=caddy
Group=caddy
AmbientCapabilities=CAP_NET_BIND_SERVICE
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=/var/lib/caddy

[Install]
WantedBy=multi-user.target
CADDYUNIT

id caddy >/dev/null 2>&1 || useradd --system --home /var/lib/caddy --shell /usr/sbin/nologin caddy
mkdir -p /var/lib/caddy
chown -R caddy:caddy /var/lib/caddy

systemctl daemon-reload
systemctl enable --now dietfantasy
systemctl enable --now caddy
systemctl restart dietfantasy
systemctl restart caddy

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "--- dietfantasy ---"
systemctl is-active dietfantasy || true
systemctl --no-pager --lines=30 status dietfantasy || true
echo "--- local login ---"
curl -sI http://127.0.0.1:3500/login | head -n 8
echo "--- caddy ---"
systemctl is-active caddy || true
systemctl --no-pager --lines=20 status caddy || true

#!/usr/bin/env bash
# T3 ambilight host — install as a systemd service that starts at boot.
#   as root : system unit  /etc/systemd/system/t3-ambilight.service
#   as user : user unit    ~/.config/systemd/user/t3-ambilight.service
#             (needs once: sudo loginctl enable-linger $USER  to start at boot)
# Run from this directory, after copying config.example.json -> config.json.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/config.json" ] || { echo "manca $DIR/config.json (copia config.example.json e compila tuya id/key/ip)"; exit 1; }

python3 -c "import PIL, tinytuya" 2>/dev/null || \
  pip3 install --user --break-system-packages pillow tinytuya 2>/dev/null || pip3 install --user pillow tinytuya

UNIT="[Unit]
Description=T3 ambilight host (TV frame sink + Tuya LED driver + agent relay)
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/bin/python3 -u $DIR/t3_ambilight.py --config $DIR/config.json
WorkingDirectory=$DIR
Restart=always
RestartSec=3
[Install]
WantedBy=TARGET"

if [ "$(id -u)" = 0 ]; then
  echo "${UNIT/TARGET/multi-user.target}" > /etc/systemd/system/t3-ambilight.service
  systemctl daemon-reload
  systemctl enable --now t3-ambilight.service
  systemctl restart t3-ambilight.service
else
  mkdir -p ~/.config/systemd/user
  echo "${UNIT/TARGET/default.target}" > ~/.config/systemd/user/t3-ambilight.service
  systemctl --user daemon-reload
  systemctl --user enable --now t3-ambilight.service
  systemctl --user restart t3-ambilight.service
  [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" = yes ] || \
    echo "NB: per l'avvio al boot serve una volta:  sudo loginctl enable-linger $USER"
fi
echo "ok — stato: curl http://localhost:8777/status"

#!/usr/bin/env bash
# T3 ambilight host — install as a systemd service that starts at boot.
#   as root : system unit  /etc/systemd/system/t3-ambilight.service
#   as user : user unit    ~/.config/systemd/user/t3-ambilight.service
#             (needs once: sudo loginctl enable-linger $USER  to start at boot)
# Run from this directory, after copying config.example.json -> config.json.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
[ -f "$DIR/config.json" ] || { echo "manca $DIR/config.json (copia config.example.json e scegli output hyperhdr|tuya)"; exit 1; }

# Python deps depend on the output mode: hyperhdr -> flatbuffers, tuya -> tinytuya.
# On Debian prefer the distro packages: apt install python3-pil python3-flatbuffers
OUTPUT=$(python3 -c "import json; print(json.load(open('$DIR/config.json')).get('output', 'tuya'))")
case "$OUTPUT" in
  hyperhdr) PYMOD=flatbuffers; PIPPKG=flatbuffers ;;
  *)        PYMOD=tinytuya;    PIPPKG=tinytuya ;;
esac
python3 -c "import PIL, $PYMOD" 2>/dev/null || \
  pip3 install --user --break-system-packages pillow "$PIPPKG" 2>/dev/null || pip3 install --user pillow "$PIPPKG" || \
  { echo "mancano dipendenze Python: pillow + $PIPPKG (su Debian: apt install python3-pil python3-$PIPPKG)"; exit 1; }

UNIT="[Unit]
Description=T3 ambilight host (TV frame sink -> HyperHDR or Tuya, + agent relay)
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

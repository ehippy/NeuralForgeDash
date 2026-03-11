#!/usr/bin/env bash
# Installs (or reinstalls) the NeuralForge systemd service.
# Run from anywhere; it figures out the project dir automatically.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
USER_NAME="$(whoami)"
HOME_DIR="$HOME"
DEST=/etc/systemd/system/neuralforge.service

if [[ $EUID -ne 0 ]]; then
  echo "Re-running with sudo..."
  exec sudo bash "$0" "$@"
fi

# Substitute placeholders
sed \
  -e "s|__USER__|${SUDO_USER:-$USER_NAME}|g" \
  -e "s|__HOME__|$(eval echo ~${SUDO_USER:-$USER_NAME})|g" \
  -e "s|__PROJECT_DIR__|${PROJECT_DIR}|g" \
  "$SCRIPT_DIR/neuralforge.service" > "$DEST"

chmod 644 "$DEST"
systemctl daemon-reload
systemctl enable neuralforge

echo "Installed to $DEST"
echo "Start with: sudo systemctl start neuralforge"
echo "Logs with:  journalctl -u neuralforge -f"

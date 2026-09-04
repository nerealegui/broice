#!/usr/bin/env bash
set -e

DEST_DIR="$HOME/.copilot/extensions/kokoro-tts"
echo "🚀 Installing Kokoro TTS Extension to $DEST_DIR..."

mkdir -p "$DEST_DIR/ui"

cp extension.mjs "$DEST_DIR/"
cp speak.py "$DEST_DIR/"
cp config.json "$DEST_DIR/"
cp ui/index.html "$DEST_DIR/ui/"
chmod +x "$DEST_DIR/speak.py"

echo "✅ Installed successfully!"
echo "👉 Reload extensions in Copilot App or run: /reload in CLI"

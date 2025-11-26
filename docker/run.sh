#!/bin/bash

if [[ -n EXPORT_ENTIRE_VAULT ]]; then
  # Copy the plugin to the vault
  mkdir -p /vault/.obsidian/plugins/webpage-html-export
  cp /plugin/* /vault/.obsidian/plugins/webpage-html-export/
fi

RUST_LOG=debug xvfb-run electron-injector \
  --delay=15000 \
  --script=/export-vault.mjs \
  obsidian \
    --arg=--remote-debugging-port=8315 \
    --arg=--remote-debugging-address=0.0.0.0 \
    --arg=--remote-allow-origins=* \
    --arg=--no-sandbox \
    --arg=--no-xshm \
    --arg=--disable-dev-shm-usage \
    --arg=--disable-gpu \
    --arg=--disable-software-rasterizer \
    --arg=--enable-logging=stderr || true
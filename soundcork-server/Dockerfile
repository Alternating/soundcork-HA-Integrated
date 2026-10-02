FROM ghcr.io/timvw/soundcork:main
COPY main.py /app/soundcork/main.py
COPY app.js /app/soundcork/webui/static/app.js
# Lovelace card served unauthenticated at /card/soundcork-preset-editor.js so
# HA loads it straight from soundcork (deploy copies it here from lovelace-card/)
COPY soundcork-preset-editor.js /app/soundcork/card/soundcork-preset-editor.js

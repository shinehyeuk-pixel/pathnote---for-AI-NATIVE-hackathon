#!/bin/bash
# Adds Pathnote to Claude Desktop's MCP servers.
# Claude Desktop rewrites its config file while it runs, so this quits it first,
# edits the file, then opens it again. Run from macOS Terminal, not from inside Claude.
#   bash add-to-claude-desktop.sh [folder ...]   (default: ~/pathnote-sample)
set -e
# Inside Claude's own terminal this can't quit Claude, and quitting it would end this shell anyway
if [ -n "$CLAUDECODE" ] || [ -n "$CLAUDE_CODE_ENTRYPOINT" ]; then
  echo "Run this from the macOS Terminal app, not from inside Claude."; exit 1
fi
[ $# -gt 0 ] || set -- "$HOME/pathnote-sample"
CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
BIN="$(npm root -g)/pathnote/bin/pathnote.js"

[ -f "$BIN" ] || { echo "Pathnote is not installed. Run: npm install -g pathnote"; exit 1; }
for f in "$@"; do [ -d "$f" ] || { echo "\"$f\" is not a folder."; exit 1; }; done

if pgrep -x Claude >/dev/null; then
  echo "Quitting Claude Desktop..."
  osascript -e 'quit app "Claude"'
  while pgrep -x Claude >/dev/null; do sleep 1; done
fi

cp "$CONFIG" "$CONFIG.bak-pathnote"
/usr/bin/python3 - "$CONFIG" "$NODE" "$BIN" "$@" <<'EOF'
import json, os, sys
path, node, bin_, *folders = sys.argv[1:]
folders = [os.path.abspath(os.path.expanduser(f)) for f in folders]
d = json.load(open(path))
d.setdefault('mcpServers', {})['pathnote'] = {'command': node, 'args': [bin_, *folders]}
json.dump(d, open(path, 'w'), indent=2, ensure_ascii=False)
print('Pathnote connected to:', *folders, sep='\n  ')
EOF

open -a Claude
echo "Claude Desktop reopened. Viewer: http://127.0.0.1:4747"

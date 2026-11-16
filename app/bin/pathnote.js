#!/usr/bin/env node
// pathnote <folder> [<folder> ...] [--port 4747] [--viewer] [--no-open] [--no-claude-code]
// pathnote [options]                no folders: the ones in ~/.pathnote/folders.json, which the user can
//                                   add to from the viewer while it runs
// pathnote setup [<folder> ...]     adds folders to that file and adds Pathnote to the AI apps on this computer
// pathnote --sample <new folder>   copies the sample notes there, to try Pathnote safely
//   Started by an MCP client: MCP over stdin/stdout, plus the viewer at http://127.0.0.1:4747
//   --viewer: only the viewer, for keeping it open while MCP clients come and go
//   --no-open (or PATHNOTE_NO_OPEN=1): don't open the viewer in the browser when the AI starts working
//   --no-claude-code (or PATHNOTE_NO_CLAUDE_CODE=1): show only Pathnote's own tools, not everything
//     Claude Code sessions in these folders do (read from its logs in ~/.claude/projects)
// stdout belongs to MCP, so every message for people goes to stderr.
import fs from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Workspace, expand } from '../src/workspace.js';
import { FOLDERS, readFolders, addFolder, existing } from '../src/folders.js';
import { setup } from '../src/setup.js';
import { History } from '../src/history.js';
import { Hub, openBrowser } from '../src/hub.js';
import { createServer } from '../src/mcp.js';
import { ClaudeCode } from '../src/claude-code.js';
import { blueprint, toMarkdown } from '../src/blueprint.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const folders = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
const folder = folders[0];

if (args[0] === 'setup') {
  try { await setup(args.slice(1)); process.exit(0); } catch (e) { console.error(`Pathnote: ${e.message}`); process.exit(1); }
}
if (flag('--sample')) {
  if (!folder) { console.error('Usage: pathnote --sample <new folder>'); process.exit(1); }
  // Windows shells pass ~ through as typed, so ~/pathnote-sample would become a folder named ~
  const dest = expand(folder);
  if (fs.existsSync(dest)) { console.error(`Pathnote: "${folder}" already exists. Pick a new folder.`); process.exit(1); }
  fs.cpSync(new URL('../examples/sample-vault', import.meta.url), dest, { recursive: true });
  console.error(`Sample notes copied to ${fs.realpathSync(dest)}`);
  process.exit(0);
}
// Without folders, the folders file says which ones (`pathnote setup` makes it)
const fromFile = !folder && readFolders() !== null;
if ((!folder && !fromFile) || flag('--help')) {
  console.error(`Pathnote ${pkg.version}\n\nUsage: pathnote setup [<folder> ...]   connect folders and add Pathnote to your AI apps\n       pathnote <folder> [<folder> ...] [--port 4747] [--viewer] [--no-open] [--no-claude-code]\n       pathnote --sample <new folder>`);
  process.exit(flag('--help') ? 0 : 1);
}
for (const f of folders) {
  if (!fs.existsSync(expand(f)) || !fs.statSync(expand(f)).isDirectory()) { // Windows shells leave ~ as typed
    console.error(`Pathnote: "${f}" is not a folder.`);
    process.exit(1);
  }
}

const ws = new Workspace(fromFile ? existing(readFolders()) : folders, { id: fromFile ? `folders:${FOLDERS}` : null });
const history = new History(ws);
const noOpen = flag('--no-open') || process.env.PATHNOTE_NO_OPEN === '1';
const follow = !(flag('--no-claude-code') || process.env.PATHNOTE_NO_CLAUDE_CODE === '1');
const claudeCode = new ClaudeCode(ws, e => hub.emit(e));
const hub = new Hub(ws, history, Number(opt('--port')) || 4747, {
  open: noOpen ? null : openBrowser, version: pkg.version, own: follow ? () => claudeCode.start().catch(() => {}) : null,
  connect: fromFile ? abs => addFolder(abs) : null,
  // from, to: the part of the session to use, as times (from a request to before a later one)
  blueprint: async (session, { lang, from, to } = {}) => {
    const { events, title } = await claudeCode.history(session);
    const part = events.filter(e => (!from || e.t >= from) && (!to || e.t < to));
    const bp = blueprint(part, { title, lang });
    return { blueprint: bp, markdown: toMarkdown(bp, { lang }), title, requests: events.filter(e => e.type === 'prompt').map(e => ({ t: e.t, text: e.text.slice(0, 120) })) };
  }
});

// The folders file changed (setup, or a folder the user let the AI connect): use the new list, and the
// process showing the viewer tells the page to draw the new map
function reload() {
  const next = existing(readFolders());
  if (next.join('\n') === ws.roots.join('\n')) return;
  ws.setRoots(next);
  if (!hub.forwardTo) hub.broadcast({ t: Date.now(), type: 'roots', roots: ws.roots });
}
if (fromFile) fs.watchFile(FOLDERS, { interval: 1000 }, reload).unref();
const url = await hub.start();
console.error(`Pathnote ${pkg.version}: ${ws.roots.join(', ') || 'no folders yet'}\nViewer: ${url}`);
ws.warm().catch(() => {});

if (!flag('--viewer')) {
  await createServer({ ws, history, hub, version: pkg.version, reload: fromFile ? reload : null }).connect(new StdioServerTransport());
  // The viewer server would keep the process alive after the MCP client quits
  process.stdin.on('close', () => process.exit(0));
}

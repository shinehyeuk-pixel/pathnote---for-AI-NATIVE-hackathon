// `pathnote setup [<folder> ...]`: one command that makes Pathnote ready to use. It adds the folders to
// the folders file (Documents, Desktop and Downloads when there is no file yet and none are named) and
// adds Pathnote to the AI apps found on this computer: Codex, Claude Desktop, Claude Code and Cursor.
// The apps start Pathnote without folders, so it reads the folders file, which can grow later.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expand } from './workspace.js';
import { FOLDERS, readFolders, writeFolders, defaultFolders, refusal, isFolder } from './folders.js';

export async function setup(argv, { home = os.homedir(), platform = process.platform, env = process.env, file = FOLDERS, run = spawnSync, log = console.error } = {}) {
  // Folders
  const named = argv.filter(a => !a.startsWith('--')).map(a => path.resolve(expand(a, home)));
  for (const f of named) { const no = refusal(f); if (no) throw new Error(no); }
  const before = readFolders(file) || [];
  const keep = before.filter(f => !named.some(n => path.resolve(f) === n));
  const folders = named.length ? [...keep, ...named] : before.length ? before : defaultFolders(home);
  writeFolders(folders, file);

  // How the apps start Pathnote. Windows apps can't start npx (a .cmd script) directly, so cmd does.
  const win = platform === 'win32';
  const command = win ? 'cmd' : 'npx';
  const args = win ? ['/c', 'npx', '-y', 'pathnote'] : ['-y', 'pathnote'];
  const added = [], skipped = [];

  // Codex: ~/.codex/config.toml (or CODEX_HOME). npx can take a while the first time, so it gets a minute.
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  if (isFolder(codex)) {
    const toml = path.join(codex, 'config.toml');
    const vars = win ? ['APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SystemRoot'].filter(k => env[k]) : [];
    const block = ['[mcp_servers.pathnote]', `command = ${JSON.stringify(command)}`, `args = ${JSON.stringify(args)}`, 'startup_timeout_sec = 60',
      // Codex passes only a few settings to the programs it starts; npx on Windows needs these to find its files
      ...(vars.length ? [`env = { ${vars.map(k => `${k} = ${JSON.stringify(env[k])}`).join(', ')} }`] : [])].join('\n');
    fs.writeFileSync(toml, withToml(read(toml), block));
    added.push('Codex');
  }

  // Claude Desktop: its config file, in each place it may live (the Microsoft Store version keeps its own)
  const desktop = platform === 'darwin' ? [path.join(home, 'Library', 'Application Support', 'Claude')]
    : win ? [env.APPDATA && path.join(env.APPDATA, 'Claude'), ...storeClaude(env.LOCALAPPDATA)]
    : [path.join(home, '.config', 'Claude')];
  let desktopFound = false;
  for (const dir of desktop.filter(Boolean).filter(isFolder)) {
    if (addJson(path.join(dir, 'claude_desktop_config.json'), { command, args })) desktopFound = true;
    else skipped.push(`${path.join(dir, 'claude_desktop_config.json')} (not valid JSON, left as it is)`);
  }
  if (desktopFound) added.push('Claude Desktop');

  // Cursor: ~/.cursor/mcp.json
  if (isFolder(path.join(home, '.cursor'))) {
    if (addJson(path.join(home, '.cursor', 'mcp.json'), { command, args })) added.push('Cursor');
    else skipped.push(`${path.join(home, '.cursor', 'mcp.json')} (not valid JSON, left as it is)`);
  }

  // Claude Code: its own command, for every project (user scope)
  const claude = (...a) => run('claude', a, { stdio: 'ignore', shell: win, env });
  if (claude('--version').status === 0) {
    claude('mcp', 'remove', 'pathnote', '--scope', 'user');
    if (claude('mcp', 'add', '--scope', 'user', 'pathnote', '--', command, ...args).status === 0) added.push('Claude Code');
  }

  log(`Pathnote can use these folders:\n${folders.map(f => `  ${f}`).join('\n') || '  (none)'}\n(the list is in ${file})\n`);
  if (added.length) {
    log(`Added Pathnote to: ${added.join(', ')}.`);
    log(`Quit ${added.length > 1 ? 'these apps' : 'it'} completely and open again${win ? ' (Claude Desktop: from its icon in the taskbar notification area)' : ''}, then start a new conversation.`);
    if (desktopFound) log('Claude Desktop rewrites its settings while it runs: if it was open, quit it and run this again.');
  } else {
    log(`No AI app found on this computer. In your app's MCP settings, add a server named pathnote that runs:\n  ${[command, ...args].join(' ')}`);
  }
  for (const s of skipped) log(`Skipped ${s}`);
  log(`\nTo connect another folder later, ask the AI (you approve it in the Pathnote viewer) or run: npx -y pathnote setup <folder>`);
  return { folders, added };
}

const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// Puts Pathnote's table in a TOML file in place of an earlier one, leaving everything else as it was
export function withToml(text, block) {
  const out = [];
  let ours = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) ours = /^\s*\[\s*mcp_servers\.("pathnote"|pathnote)\s*[\].]/.test(line);
    if (!ours) out.push(line);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return (out.length ? out.join('\n') + '\n\n' : '') + block + '\n';
}

// Sets mcpServers.pathnote in a JSON config file. False if the file isn't JSON (it is left alone).
function addJson(file, entry) {
  let config = {};
  const text = read(file);
  if (text.trim()) { try { config = JSON.parse(text); } catch { return false; } }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  config.mcpServers = { ...(config.mcpServers || {}), pathnote: entry };
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return true;
}

function storeClaude(local) {
  if (!local) return [];
  try {
    return fs.readdirSync(path.join(local, 'Packages')).filter(n => /^Claude_/.test(n))
      .map(n => path.join(local, 'Packages', n, 'LocalCache', 'Roaming', 'Claude'));
  } catch { return []; }
}

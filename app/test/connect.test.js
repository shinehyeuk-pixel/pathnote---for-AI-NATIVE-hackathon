// `pathnote setup` and connecting folders later: setup adds the folders file and Pathnote to the AI apps
// (in a made-up home folder), and the AI's connect_folder request waits for the user's answer in the viewer.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setup, withToml } from '../src/setup.js';
import { readFolders } from '../src/folders.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'pathnote.js');
const PORT = 4798;
const VIEWER = `http://127.0.0.1:${PORT}`;
const quiet = () => {};
let tmp;
const clients = [];

before(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-connect-'))); });
after(async () => { for (const c of clients) await c.close(); await fs.rm(tmp, { recursive: true, force: true }); });

const mk = async (...p) => { const d = path.join(...p); await fs.mkdir(d, { recursive: true }); return d; };
// What `claude` would be asked to do, without running it
const fakeClaude = calls => (cmd, args) => { calls.push([cmd, ...args].join(' ')); return { status: 0 }; };

test('setup connects the usual folders and adds Pathnote to the apps it finds, keeping their other settings', async () => {
  const home = await mk(tmp, 'mac');
  const docs = await mk(home, 'Documents'), downloads = await mk(home, 'Downloads');
  await mk(home, '.codex');
  await fs.writeFile(path.join(home, '.codex', 'config.toml'),
    'model = "gpt-5"\n\n[mcp_servers.pathnote]\ncommand = "old"\n\n[mcp_servers.pathnote.env]\nX = "1"\n\n[mcp_servers.other]\ncommand = "other"\n');
  const claudeDir = await mk(home, 'Library', 'Application Support', 'Claude');
  await fs.writeFile(path.join(claudeDir, 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }));
  await mk(home, '.cursor');
  await fs.writeFile(path.join(home, '.cursor', 'mcp.json'), '{ not json');
  const file = path.join(home, '.pathnote', 'folders.json'), calls = [];

  const r = await setup([], { home, platform: 'darwin', env: {}, file, run: fakeClaude(calls), log: quiet });
  assert.deepEqual(r.folders, [docs, downloads]);
  assert.deepEqual(readFolders(file), [docs, downloads]);
  assert.deepEqual(r.added, ['Codex', 'Claude Desktop', 'Claude Code']);

  const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.equal(toml.match(/\[mcp_servers\.pathnote\]/g).length, 1);
  assert.ok(!toml.includes('command = "old"') && !toml.includes('X = "1"'));
  assert.ok(toml.includes('model = "gpt-5"') && toml.includes('[mcp_servers.other]\ncommand = "other"'));
  assert.ok(toml.includes('command = "npx"\nargs = ["-y","pathnote"]\nstartup_timeout_sec = 60'));

  const desktop = JSON.parse(await fs.readFile(path.join(claudeDir, 'claude_desktop_config.json'), 'utf8'));
  assert.deepEqual(desktop, { mcpServers: { other: { command: 'x' }, pathnote: { command: 'npx', args: ['-y', 'pathnote'] } }, theme: 'dark' });
  assert.equal(await fs.readFile(path.join(home, '.cursor', 'mcp.json'), 'utf8'), '{ not json'); // left alone
  assert.ok(calls.includes('claude mcp add --scope user pathnote -- npx -y pathnote'));

  // Run again with a folder: it is added to the list, the others stay
  const notes = await mk(home, 'notes');
  assert.deepEqual((await setup(['~/notes'], { home, platform: 'darwin', env: {}, file, run: fakeClaude([]), log: quiet })).folders, [docs, downloads, notes]);
  await assert.rejects(setup([path.join(home, 'nope')], { home, platform: 'darwin', env: {}, file, run: fakeClaude([]), log: quiet }), /not a folder/);
});

test('on Windows the apps start Pathnote through cmd, Codex gets the settings npx needs, and both Claude Desktop places are set', async () => {
  const home = await mk(tmp, 'win');
  const env = { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), USERPROFILE: home };
  await mk(home, '.codex');
  const roaming = await mk(env.APPDATA, 'Claude');
  const store = await mk(env.LOCALAPPDATA, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude');
  const docs = await mk(home, 'OneDrive', 'Documents');
  const calls = [];
  const r = await setup([], { home, platform: 'win32', env, file: path.join(home, '.pathnote', 'folders.json'), run: fakeClaude(calls), log: quiet });
  assert.deepEqual(r.folders, [docs]);
  const entry = { command: 'cmd', args: ['/c', 'npx', '-y', 'pathnote'] };
  for (const dir of [roaming, store]) assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'claude_desktop_config.json'), 'utf8')).mcpServers.pathnote, entry);
  const toml = await fs.readFile(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.ok(toml.includes('command = "cmd"\nargs = ["/c","npx","-y","pathnote"]'));
  assert.ok(toml.includes(`APPDATA = ${JSON.stringify(env.APPDATA)}`) && toml.includes(`USERPROFILE = ${JSON.stringify(home)}`));
  assert.ok(calls.includes('claude mcp add --scope user pathnote -- cmd /c npx -y pathnote'));
});

test('withToml writes into an empty file and keeps a file without Pathnote as it was', () => {
  assert.equal(withToml('', '[mcp_servers.pathnote]'), '[mcp_servers.pathnote]\n');
  assert.equal(withToml('a = 1\r\n', '[b]'), 'a = 1\n\n[b]\n');
});

test('the AI connects a folder by name once the user allows it in the viewer, and a second app asks through the first', async () => {
  const home = await mk(tmp, 'live');
  const notes = await mk(home, 'notes');
  const lectures = await mk(home, 'Documents', '강의'), other = await mk(home, 'Desktop', 'other');
  await fs.writeFile(path.join(lectures, '15강.md'), '# 15강');
  await mk(home, '.pathnote');
  await fs.writeFile(path.join(home, '.pathnote', 'folders.json'), JSON.stringify({ folders: [notes] }));
  const start = async () => {
    const c = new Client({ name: 'test', version: '1' });
    await c.connect(new StdioClientTransport({
      command: process.execPath, args: [BIN, '--port', String(PORT), '--no-claude-code'],
      env: { ...process.env, HOME: home, USERPROFILE: home, PATHNOTE_NO_OPEN: '1', PATHNOTE_FOLDERS: '' }, stderr: 'ignore'
    }));
    clients.push(c);
    return c;
  };
  const first = await start();
  const call = (c, name, args) => c.callTool({ name, arguments: args }).then(r => r.content[0].text);
  assert.ok((await first.listTools()).tools.some(t => t.name === 'connect_folder'));
  assert.equal(await call(first, 'list_files', {}), notes);

  // Answers the next request the viewer shows
  const answer = async yes => {
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${VIEWER}/api/events`);
      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel();
      const evs = new TextDecoder().decode(value).split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(6)));
      const done = new Set(evs.filter(e => e.type === 'answered').map(e => e.id));
      const ask = evs.find(e => e.type === 'ask' && !done.has(e.id));
      if (ask) {
        const r = await fetch(`${VIEWER}/api/answer`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: VIEWER }, body: JSON.stringify({ id: ask.id, yes }) });
        assert.equal(r.status, 200);
        return ask;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('no request showed up');
  };

  const [said, ask] = await Promise.all([call(first, 'connect_folder', { folder: '강의', reason: '15강 노트를 찾으려고' }), answer(true)]);
  assert.equal(ask.path, lectures);
  assert.equal(ask.reason, '15강 노트를 찾으려고');
  assert.match(said, /^Connected /);
  assert.equal(await call(first, 'list_files', {}), `${notes}\n${lectures}`);
  assert.match(await call(first, 'read_file', { path: path.join(lectures, '15강.md') }), /15강/);
  assert.deepEqual(readFolders(path.join(home, '.pathnote', 'folders.json')), [notes, lectures]);

  // A second app's Pathnote forwards its request to the viewer the first one shows; declining connects nothing
  const second = await start();
  const [no] = await Promise.all([call(second, 'connect_folder', { folder: other }), answer(false)]);
  assert.match(no, /declined/);
  assert.match(await call(second, 'list_files', {}), new RegExp(`^${notes}\n${lectures}$`));
  assert.match(await call(second, 'connect_folder', { folder: path.join(lectures) }), /already connected/);
  // the second process picked up the folder the first one added, from the file
  assert.match(await call(second, 'read_file', { path: path.join(lectures, '15강.md') }), /15강/);
});

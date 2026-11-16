// Runs Pathnote the way an MCP client does (stdio) against copies of the sample notes in two folders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, '..', 'bin', 'pathnote.js');
const PORT = 4799;
const VIEWER = `http://127.0.0.1:${PORT}`;
let tmp, notes, code, home, client, second;

async function connect() {
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(new StdioClientTransport({
    command: process.execPath, args: [BIN, notes, code, '--port', String(PORT)],
    env: { ...process.env, HOME: home, PATHNOTE_NO_OPEN: '1' }, stderr: 'ignore'
  }));
  return c;
}
const call = (c, name, args) => c.callTool({ name, arguments: args });
const out = r => r.content[0].text;
const events = async () => {
  // read what the viewer has so far, then stop listening
  const res = await fetch(`${VIEWER}/api/events`, { headers: { Origin: VIEWER } });
  const reader = res.body.getReader();
  const { value } = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(value).split('\n\n').filter(Boolean).map(l => JSON.parse(l.slice(6)));
};
const post = (p, body, origin = VIEWER) => fetch(VIEWER + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body)
});

before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-test-')));
  notes = path.join(tmp, 'notes'); code = path.join(tmp, 'code'); home = path.join(tmp, 'home');
  await fs.cp(path.join(here, '..', 'examples', 'sample-vault'), notes, { recursive: true });
  await fs.mkdir(path.join(code, 'src'), { recursive: true });
  await fs.mkdir(path.join(code, 'secrets'));
  await fs.mkdir(path.join(code, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(code, 'src', 'cache.js'), 'export const TTL = 300; // onboarding cache\n');
  await fs.writeFile(path.join(code, '.env'), 'API_KEY=shh');
  await fs.writeFile(path.join(code, 'secrets', 'token.txt'), 'shh');
  await fs.writeFile(path.join(code, 'node_modules', 'x', 'index.js'), 'x');
  await fs.writeFile(path.join(code, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  await fs.writeFile(path.join(code, 'blob.bin'), Buffer.from([1, 0, 2, 0, 3]));
  await fs.writeFile(path.join(tmp, 'outside.md'), 'outside');
  client = await connect();
});
after(async () => { await client?.close(); await second?.close(); await fs.rm(tmp, { recursive: true, force: true }); });

test('lists the tools and the connected folders', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name).sort(), ['edit_file', 'get_blueprint', 'list_files', 'move_file', 'read_file', 'search_files', 'write_file']);
  assert.equal(out(await call(client, 'list_files', {})), `${notes}\n${code}`);
  const src = out(await call(client, 'list_files', { folder: code }));
  assert.equal(src, 'blob.bin\nlogo.png\nsrc/', 'hides .env, secrets/ and node_modules/');
});

test('search, read and graph across folders', async () => {
  const s = out(await call(client, 'search_files', { query: 'setup onboarding', reason: 'find onboarding' }));
  assert.match(s, /Customer interviews\.md/);
  assert.match(s, /cache\.js/);
  assert.match(out(await call(client, 'read_file', { path: path.join(notes, 'Research', 'Customer interviews.md') })), /5 of 7/);
  const g = await (await fetch(`${VIEWER}/api/graph`)).json();
  assert.deepEqual(g.roots, [notes, code]);
  const ids = g.items.map(i => i.id);
  assert.ok(ids.includes(path.join(code, 'src', 'cache.js')));
  assert.ok(!ids.some(i => /\.env|secrets|node_modules/.test(i)));
  assert.ok(g.links.some(([a, b]) => a.endsWith('Oct team meeting.md') && b.endsWith('Customer interviews.md')));
});

test('refuses paths outside the folders, secrets, unknown binaries and relative paths', async () => {
  for (const p of [path.join(tmp, 'outside.md'), path.join(notes, '..', 'outside.md'), '/etc/hosts',
    path.join(code, '.env'), path.join(code, 'secrets', 'token.txt'), path.join(code, 'node_modules', 'x', 'index.js'),
    path.join(code, 'blob.bin'), 'Ideas.md']) {
    assert.equal((await call(client, 'read_file', { path: p })).isError, true, p);
  }
  assert.equal((await call(client, 'write_file', { path: path.join(tmp, 'evil.md'), content: 'x' })).isError, true);
  await assert.rejects(fs.access(path.join(tmp, 'evil.md')));
});

test('pictures are sent as images', async () => {
  const r = await call(client, 'read_file', { path: path.join(code, 'logo.png') });
  assert.equal(r.content[0].type, 'image');
  assert.equal(r.content[0].mimeType, 'image/png');
});

test('a symlink inside a folder cannot lead outside it', async () => {
  await fs.symlink(tmp, path.join(notes, 'escape'));
  assert.equal((await call(client, 'read_file', { path: path.join(notes, 'escape', 'outside.md') })).isError, true);
  await fs.rm(path.join(notes, 'escape'));
});

test('write, edit and undo in any text file', async () => {
  const plan = path.join(notes, 'Priorities.md'), src = path.join(code, 'src', 'cache.js');
  await call(client, 'write_file', { path: plan, content: 'Onboarding first.\n', reason: 'summary' });
  await call(client, 'edit_file', { path: src, find: 'TTL = 300', replace: 'TTL = 60' });
  assert.equal((await call(client, 'edit_file', { path: src, find: 'missing', replace: 'x' })).isError, true);

  const ev = (await events()).filter(e => e.type === 'write' || e.type === 'edit');
  assert.equal(ev[0].created, true);
  assert.equal((await post('/api/undo', { id: ev[0].changeId })).status, 200);
  await assert.rejects(fs.access(plan));
  assert.equal((await post('/api/undo', { id: ev[0].changeId })).status, 409);
  assert.equal((await post('/api/undo', { id: ev[1].changeId })).status, 200);
  assert.match(await fs.readFile(src, 'utf8'), /TTL = 300/);
});

test('undo leaves a file alone if the user changed it after the AI', async () => {
  const draft = path.join(notes, 'Draft.md');
  await call(client, 'write_file', { path: draft, content: 'AI text' });
  await fs.writeFile(draft, 'AI text, then my edits');
  const w = (await events()).filter(e => e.type === 'write').pop();
  assert.equal((await post('/api/undo', { id: w.changeId })).status, 409);
  assert.equal(await fs.readFile(draft, 'utf8'), 'AI text, then my edits');
});

test('move files and folders across connected folders, and undo', async () => {
  const pic = path.join(code, 'logo.png'), to = path.join(notes, 'Assets', 'logo.png');
  assert.equal((await call(client, 'move_file', { from: pic, to })).isError, undefined);
  await assert.rejects(fs.access(pic));
  await fs.access(to);
  // folders move whole, but never on top of something or with secrets inside
  assert.equal((await call(client, 'move_file', { from: path.join(code, 'src'), to: path.join(notes, 'Assets') })).isError, true);
  assert.equal((await call(client, 'move_file', { from: code, to: path.join(notes, 'code') })).isError, true, 'connected folder itself');
  await fs.mkdir(path.join(code, 'kit', 'secrets'), { recursive: true });
  await fs.writeFile(path.join(code, 'kit', 'secrets', 'k.txt'), 'shh');
  assert.equal((await call(client, 'move_file', { from: path.join(code, 'kit'), to: path.join(notes, 'kit') })).isError, true, 'holds secrets');
  assert.equal((await call(client, 'move_file', { from: path.join(code, 'src'), to: path.join(notes, 'Code', 'src') })).isError, undefined);
  await fs.access(path.join(notes, 'Code', 'src', 'cache.js'));

  const moves = (await events()).filter(e => e.type === 'move');
  assert.equal(moves[0].from, pic);
  assert.equal((await post('/api/undo', { id: moves[0].changeId })).status, 200);
  await fs.access(pic);
  await assert.rejects(fs.access(to));
  assert.equal((await post('/api/undo', { id: moves[1].changeId })).status, 200);
  await fs.access(path.join(code, 'src', 'cache.js'));
});

test('other websites cannot call the API', async () => {
  assert.equal((await post('/api/undo', { id: 'x' }, 'https://evil.example')).status, 403);
  assert.equal((await post('/api/undo', { id: 'x' }, '')).status, 403);
});

test('a second process for the same folders reports to the same viewer', async () => {
  second = await connect();
  await call(second, 'list_files', { folder: code });
  const last = (await events()).pop();
  assert.equal(last.type, 'list');
  assert.equal(last.path, code);
});

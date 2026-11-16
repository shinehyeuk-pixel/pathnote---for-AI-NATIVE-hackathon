// Holes found in review: links that lead out of the folders or into secret ones, secret folders in
// another letter case, folders macOS won't let us read, folders inside folders, a cut-off undo history,
// odd Claude Code records, and documents that unpack to far more than their size.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { Workspace } from '../src/workspace.js';
import { History } from '../src/history.js';
import { ClaudeCode } from '../src/claude-code.js';
import { documentText } from '../src/documents.js';

let tmp, notes, outside;
before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-guards-')));
  notes = path.join(tmp, 'notes'); outside = path.join(tmp, 'outside');
  await fs.mkdir(path.join(notes, 'secrets'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(notes, 'secrets', 'token.txt'), 'shh');
});
after(async () => {
  await fs.chmod(path.join(tmp, 'denied'), 0o755).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
});

test('a link can\'t lead a write outside the folders or a read into a secret folder', async () => {
  const ws = new Workspace([notes]);
  await fs.symlink(path.join(outside, 'target.md'), path.join(notes, 'link.md')); // points at nothing yet
  await assert.rejects(ws.write(path.join(notes, 'link.md'), 'x'), /outside the connected folders/);
  assert.equal(await fs.access(path.join(outside, 'target.md')).then(() => true, () => false), false);
  await fs.symlink(path.join(outside, 'gone'), path.join(notes, 'dir')); // a folder link to nothing, then a file in it
  await assert.rejects(ws.write(path.join(notes, 'dir', 'a.md'), 'x'), /outside the connected folders/);
  await fs.symlink(path.join(notes, 'secrets'), path.join(notes, 'innocent'));
  await assert.rejects(ws.read(path.join(notes, 'innocent', 'token.txt')), /secrets/);
  // a link that stays inside and away from secrets still works
  await fs.writeFile(path.join(notes, 'real.md'), 'hello');
  await fs.symlink(path.join(notes, 'real.md'), path.join(notes, 'alias.md'));
  assert.equal(await ws.read(path.join(notes, 'alias.md')), 'hello');
});

test('secret folders count in any letter case', () => {
  const ws = new Workspace([notes]);
  for (const p of ['Secrets/token.txt', '.SSH/id', '.Kube/config', 'x/.git-credentials']) assert.throws(() => ws.resolve(path.join(notes, p)), /secrets/);
});

test('a folder macOS won\'t let us read shows as blocked, not empty; a folder inside another is listed once', async () => {
  if (process.getuid?.() === 0) return; // root reads anything
  const denied = path.join(tmp, 'denied');
  await fs.mkdir(denied); await fs.writeFile(path.join(denied, 'a.md'), 'x');
  await fs.chmod(denied, 0o000);
  const ws = new Workspace([notes, denied, path.join(notes, 'secrets'), notes]);
  assert.deepEqual(ws.roots, [notes, denied]);
  const g = await ws.graph();
  assert.deepEqual(g.blocked, [denied]);
  await assert.rejects(ws.list(denied), /blocking access/);
  await fs.chmod(denied, 0o755);
});

test('a history line cut short doesn\'t break undo, and the next entry starts on its own line', async () => {
  const home = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const h = new History(new Workspace([notes]));
    process.env.HOME = home;
    const first = await h.record(path.join(notes, 'a.md'), null, 'one', 'write');
    await fs.appendFile(h.file, '{"id":"cut sho');
    const second = await h.record(path.join(notes, 'b.md'), null, 'two', 'write');
    assert.deepEqual((await h.all()).map(e => e.id), [first.id, second.id]);
  } finally { process.env.HOME = home; }
});

test('an odd Claude Code record doesn\'t cost the records after it', async () => {
  const logs = path.join(tmp, 'logs', 'p');
  await fs.mkdir(logs, { recursive: true });
  const log = path.join(logs, 's.jsonl');
  const at = new Date(Date.now() + 1000).toISOString();
  const line = r => JSON.stringify({ sessionId: 's', cwd: notes, timestamp: at, ...r }) + '\n';
  await fs.writeFile(log, '');
  const events = [];
  const cc = new ClaudeCode(new Workspace([notes]), e => events.push(e), { dir: path.dirname(logs) });
  await cc.start(); cc.stop();
  await fs.appendFile(log, line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'mcp__claude-in-chrome__browser_batch', input: { actions: 'not a list' } }] } })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'still here' }] } }));
  await cc.read(log);
  assert.ok(events.some(e => e.type === 'say' && e.text === 'still here'));
});

test('a document that unpacks to far more than its size is refused', async () => {
  const bomb = Buffer.from(zipSync({ 'word/document.xml': new Uint8Array(65 * 1024 * 1024) }, { level: 9 }));
  assert.ok(bomb.length < 1024 * 1024);
  await assert.rejects(documentText('big.docx', bomb), /more than 64 MB/);
});

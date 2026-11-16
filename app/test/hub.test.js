// The viewer server: opening the page in the browser, and showing files in Finder.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { History } from '../src/history.js';
import { Hub } from '../src/hub.js';

const dirs = [];
after(() => Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true }))));

async function hub(port, opened, revealed = []) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-open-')));
  dirs.push(dir);
  const ws = new Workspace([dir]);
  const h = new Hub(ws, new History(ws), port, { open: url => opened.push(url), reveal: p => revealed.push(p) });
  await h.start();
  h.dir = dir;
  return h;
}

test('opens the viewer once, on the first event', async () => {
  const opened = [];
  const h = await hub(4796, opened);
  assert.deepEqual(opened, [], 'not at startup');
  await h.emit({ type: 'list', path: '/x' });
  await h.emit({ type: 'read', path: '/x/a.md' });
  assert.deepEqual(opened, [`http://127.0.0.1:${h.port}`]);
  h.server.closeAllConnections();
  h.server.close();
});

test('does not open a second page when one is already connected', async () => {
  const opened = [];
  const h = await hub(4795, opened);
  const res = await fetch(`http://127.0.0.1:${h.port}/api/events`);
  const reader = res.body.getReader();
  await h.emit({ type: 'list', path: '/x' });
  assert.deepEqual(opened, []);
  await reader.cancel();
  h.server.closeAllConnections();
  h.server.close();
});

test('shows files in Finder only inside the folders, and only for the viewer page', async () => {
  const revealed = [];
  const h = await hub(4794, [], revealed);
  const file = path.join(h.dir, 'note.md');
  await fs.writeFile(file, 'x');
  await fs.writeFile(path.join(h.dir, '.env'), 'KEY=1');
  const viewer = `http://127.0.0.1:${h.port}`;
  const reveal = (p, origin = viewer) => fetch(`${viewer}/api/reveal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ path: p })
  });
  assert.equal((await reveal(file)).status, 200);
  assert.equal((await reveal('/etc/hosts')).status, 404);
  assert.equal((await reveal(path.join(h.dir, '.env'))).status, 404, 'secret file');
  assert.equal((await reveal(path.join(h.dir, 'gone.md'))).status, 404);
  assert.equal((await reveal(file, 'https://evil.example')).status, 403);
  // a file outside the folders shows too, but only one the AI touched (it is in the events)
  const outside = path.join(path.dirname(h.dir), `outside-${h.port}.png`), other = path.join(path.dirname(h.dir), `other-${h.port}.png`);
  await fs.writeFile(outside, 'x'); await fs.writeFile(other, 'x');
  h.broadcast({ t: Date.now(), type: 'step', place: 'files', tool: 'Read', text: outside });
  assert.equal((await reveal(outside)).status, 200);
  assert.equal((await reveal(other)).status, 404);
  await fs.rm(outside); await fs.rm(other);
  assert.deepEqual(revealed, [file, outside]);
  h.server.closeAllConnections();
  h.server.close();
});

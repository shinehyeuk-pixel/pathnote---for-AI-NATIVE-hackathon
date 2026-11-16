// Windows paths (C:\Users\me\notes) checked here on any computer: the server's helpers take path.win32,
// and the viewer's name helpers are taken out of its page and run on Windows-style paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expand, within } from '../src/workspace.js';
import { imageContent } from '../src/documents.js';

const win = path.win32;

test('~ means the home folder, also as ~\\ on Windows', () => {
  assert.equal(expand('~\\notes', 'C:\\Users\\me', win), 'C:\\Users\\me\\notes');
  assert.equal(expand('~/notes', 'C:\\Users\\me', win), 'C:\\Users\\me/notes');
  assert.equal(expand('~', 'C:\\Users\\me', win), 'C:\\Users\\me');
  assert.equal(expand('~notes', 'C:\\Users\\me', win), '~notes');
  // elsewhere \ is part of a file name
  assert.equal(expand('~\\notes', '/Users/me', path.posix), '~\\notes');
  assert.equal(expand('~/notes', '/Users/me', path.posix), '/Users/me/notes');
});

test('inside a connected folder on Windows: any case, and whole drives', () => {
  assert.ok(within('C:\\Users\\me\\notes\\a.md', 'C:\\Users\\me\\notes', win));
  assert.ok(within('c:\\users\\me\\NOTES\\a.md', 'C:\\Users\\me\\notes', win));
  assert.ok(within('C:\\Users\\me\\notes', 'c:\\users\\me\\notes', win));
  assert.ok(!within('C:\\Users\\me\\notes2\\a.md', 'C:\\Users\\me\\notes', win));
  assert.ok(!within('D:\\notes\\a.md', 'C:\\notes', win));
  assert.ok(within('D:\\notes\\a.md', 'D:\\', win));
  // case still counts elsewhere, and / holds everything
  assert.ok(!within('/Users/me/Notes/a.md', '/Users/me/notes', path.posix));
  assert.ok(within('/Users/me/a.md', '/', path.posix));
});

test('the viewer names and places Windows paths', async () => {
  const html = await fs.readFile(new URL('../viewer/index.html', import.meta.url), 'utf8');
  const code = html.slice(html.indexOf('const base = '), html.indexOf('// Radial tree'));
  const { base, parentOf, under } = new Function(`${code}; return { base, parentOf, under };`)();
  assert.equal(base('C:\\Users\\me\\notes\\a.md'), 'a.md');
  assert.equal(base('C:\\Users\\me\\notes'), 'notes');
  assert.equal(base('/Users/me/notes/a.md'), 'a.md');
  assert.equal(parentOf('C:\\Users\\me\\notes\\a.md'), 'C:\\Users\\me\\notes');
  assert.equal(parentOf('C:\\a.md'), 'C:\\');
  assert.equal(parentOf('/Users/me/a.md'), '/Users/me');
  assert.equal(parentOf('/a.md'), '/');
  assert.ok(under('C:\\Users\\me\\notes\\a.md', 'C:\\Users\\me\\notes'));
  assert.ok(!under('C:\\Users\\me\\notes2', 'C:\\Users\\me\\notes'));
  assert.ok(under('D:\\a.md', 'D:\\'));
  assert.ok(under('/Users/me/notes/a.md', '/Users/me/notes'));
});

test('off a Mac, HEIC and big pictures say what to do instead', async () => {
  const was = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    await assert.rejects(imageContent('C:\\p\\photo.heic', Buffer.alloc(10)), /HEIC picture.*only convert on a Mac.*JPEG or PNG/);
    await assert.rejects(imageContent('C:\\p\\big.png', Buffer.alloc(4 * 1024 * 1024)), /too large.*only shrink pictures on a Mac/);
  } finally {
    Object.defineProperty(process, 'platform', was);
  }
});

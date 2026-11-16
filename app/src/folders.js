// The folders file (~/.pathnote/folders.json): which folders Pathnote may use when an AI app starts it
// without naming any. `pathnote setup` writes it, and so does the viewer when the user lets the AI
// connect another folder. Every running Pathnote reads it again when it changes.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expand, within, secretDir } from './workspace.js';

export const FOLDERS = process.env.PATHNOTE_FOLDERS || path.join(os.homedir(), '.pathnote', 'folders.json');

// The folders listed in the file, or null when there is no file yet
export function readFolders(file = FOLDERS) {
  try {
    const { folders } = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(folders) ? folders.filter(f => typeof f === 'string') : [];
  } catch {
    return null;
  }
}

export function writeFolders(folders, file = FOLDERS) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // written whole and then renamed, so a Pathnote reading it never sees half a file
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ folders }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Adds a folder unless it is already in the list. Returns the new list.
export function addFolder(abs, file = FOLDERS) {
  const now = readFolders(file) || [];
  if (now.some(f => same(f, abs))) return now;
  const next = [...now, abs];
  writeFolders(next, file);
  return next;
}

const same = (a, b) => within(a, b) && within(b, a);
export const isFolder = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// The listed folders that are still there
export const existing = folders => (folders || []).map(f => path.resolve(expand(f))).filter(isFolder);

// Where people keep their files, when setup is given no folders: Documents, Desktop and Downloads,
// also where OneDrive keeps them on Windows
export function defaultFolders(home = os.homedir()) {
  const names = ['Documents', 'Desktop', 'Downloads', '문서', '바탕 화면'];
  let bases = [home];
  try { bases = bases.concat(fs.readdirSync(home).filter(n => /^OneDrive/.test(n)).map(n => path.join(home, n))); } catch {}
  return bases.flatMap(b => names.map(n => path.join(b, n))).filter(isFolder);
}

// Why Pathnote won't take a folder, or null. The user still approves every folder the AI asks for.
export function refusal(abs) {
  if (!isFolder(abs)) return `"${abs}" is not a folder.`;
  if (abs.split(/[\\/]/).some(secretDir)) return `"${abs}" looks like it holds secrets, so Pathnote won't connect it.`;
  return null;
}

// Folders with this name under the home folder, nearest first: the AI may only know "the lecture folder".
// Skips hidden, app and system folders, and gives up after a few seconds on a huge home folder.
const PASS = new Set(['AppData', 'Library', 'Applications', 'node_modules', 'Program Files', 'Windows', '$Recycle.Bin']);
export async function findFolders(name, home = os.homedir(), { depth = 4, limit = 5000, ms = 3000 } = {}) {
  const want = name.trim().toLowerCase();
  const found = [], until = Date.now() + ms;
  let seen = 0, level = [home];
  for (let d = 0; d < depth && level.length && found.length < 10; d++) {
    const next = [];
    for (const dir of level) {
      if (seen++ > limit || Date.now() > until) return found;
      let entries = [];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || PASS.has(e.name) || secretDir(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.name.toLowerCase() === want) found.push(abs);
        next.push(abs);
      }
    }
    level = next;
  }
  return found;
}

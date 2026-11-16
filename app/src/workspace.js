// The folders Pathnote may touch. Every path from the AI is checked against them: it must be
// inside one of the folders (after following symlinks), not in a skipped folder, and not a
// file that usually holds secrets.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDocument, isImage, documentText, imageContent, MAX_DOC } from './documents.js';

const SKIP = new Set(['.git', '.obsidian', '.trash', '.Trash', 'node_modules', '.build', 'build', 'DerivedData', 'dist', '.wrangler', '.venv', '__pycache__']);
// Word and LibreOffice leave these lock files next to open documents
const LOCK = /^(~\$|\.~lock\.)/;
// Folders and files that usually hold secrets. Matched in any letter case: macOS and Windows treat
// Secrets/ and secrets/ as the same folder.
export const SECRET_DIRS = new Set(['secrets', '.ssh', '.gnupg', '.aws', '.kube', '.docker', '.config']);
export const secretDir = name => SECRET_DIRS.has(String(name).toLowerCase());
const SECRET_FILE = /^(\.env(\..*)?|.*\.(pem|p8|p12|key|keystore|jks)|id_(rsa|ed25519|ecdsa)(\.pub)?|credentials\.json|token\.json|client_secret.*\.json|\.npmrc|\.netrc|\.git-credentials|\.pgpass|\.pypirc)$/i;
const TEXT = /\.(md|mdx|txt|markdown|csv|tsv|json|jsonc|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|m|h|c|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|r|lua|tex|bib|srt|vtt|log)$/i;
const LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
const MAX_READ = 2 * 1024 * 1024;
const MAX_SEARCH = 512 * 1024;
// Text kept in memory for search and links. Past this many bytes, files are read each time instead.
const CACHE_BYTES = 64 * 1024 * 1024;
// Files read at once: enough to hide disk latency, few enough to stay under open-file limits
const READS = 16;
export const MAX_NODES = 6000;
// Documents (PDF, Word…) whose text is kept for search; each can be up to 200,000 characters
const DOCS_KEPT = 300;

const BLOCKED = 'macOS is blocking access to this folder. Allow it in System Settings → Privacy & Security → Files and Folders (for the app that runs Pathnote), then try again.';

// macOS holds file calls on protected folders (Desktop, Downloads, iCloud Drive) until the user
// answers a permission prompt, possibly forever. Give up after `ms` instead of hanging.
// The timer is cleared once the call settles, so thousands of reads don't leave thousands of timers.
const timeout = (promise, ms) => {
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(Object.assign(new Error(BLOCKED), { code: 'EBLOCKED' })), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

const denied = e => e?.code === 'EPERM' || e?.code === 'EACCES';

// fn over every item with at most n running at once; results in the items' order
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const exists = p => fs.access(p).then(() => true, () => false);

// First file under `dir` that looks like it holds secrets, or null
async function findSecret(dir) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (SECRET_FILE.test(e.name) || (e.isDirectory() && secretDir(e.name))) return abs;
    if (e.isDirectory()) { const found = await findSecret(abs); if (found) return found; }
  }
  return null;
}

// ~ is the home folder: ~/notes, and ~\notes on Windows (elsewhere \ is a normal character in file names)
export const expand = (p, home = os.homedir(), at = path) => String(p || '').trim()
  .replace(at.sep === '\\' ? /^~(?=$|[\\/])/ : /^~(?=$|\/)/, home);

// abs is the folder r or inside it. Windows doesn't tell C:\Notes from c:\notes, so neither do we there.
// A whole drive (C:\) or / already ends with the separator.
export function within(abs, r, at = path) {
  if (at.sep === '\\') { abs = abs.toLowerCase(); r = r.toLowerCase(); }
  return abs === r || abs.startsWith(r.endsWith(at.sep) ? r : r + at.sep);
}

export class Workspace {
  // id: what tells two Pathnote processes they show the same map. Folders from the folders file keep one
  // id while folders are added to it; folders given on the command line are their own id.
  constructor(folders, { id = null } = {}) {
    this.setRoots(folders);
    this.id = id || this.roots.join('\n');
  }

  // A folder inside another connected folder is already covered, and listing it twice would draw and
  // find its files twice
  setRoots(folders) {
    const all = [...new Set(folders.map(f => path.resolve(expand(f))))];
    this.roots = all.filter(r => !all.some(o => o !== r && within(r, o)));
  }

  // Full path for something the AI named. Relative paths are allowed when there is one folder.
  resolve(p) {
    let s = expand(p);
    if (!s) throw new Error('Path is empty.');
    if (!path.isAbsolute(s)) {
      if (this.roots.length > 1) throw new Error(`Use a full path, e.g. ${path.join(this.roots[0], s)}`);
      s = path.join(this.roots[0], s);
    }
    let abs = path.resolve(s);
    const root = this.rootOf(abs);
    if (!root) throw new Error(`"${p}" is outside the connected folders: ${this.roots.join(', ')}`);
    // spelled like the connected folder, so the viewer finds it on the map whatever case the AI used
    abs = root + abs.slice(root.length);
    const parts = path.relative(root, abs).split(path.sep);
    if (parts.some(x => SKIP.has(x))) throw new Error(`"${p}" is in a folder Pathnote skips.`);
    if (parts.some(secretDir) || SECRET_FILE.test(path.basename(abs))) throw new Error(`"${p}" looks like it holds secrets, so Pathnote won't open it.`);
    return abs;
  }

  rootOf(abs) {
    return this.roots.find(r => within(abs, r));
  }

  // resolve(), then the same checks on where the path really leads once symlinks are followed
  async real(p) {
    const abs = this.resolve(p);
    const roots = await Promise.all(this.roots.map(r => fs.realpath(r).catch(() => r)));
    await this.leads(abs, roots, p, 0);
    return abs;
  }

  // Where `abs` really is: the existing part with links followed, plus the part that doesn't exist yet.
  // A link to something that doesn't exist yet counts as its target, since writing through it creates
  // the target. It must be in a connected folder and not in a skipped or secret one.
  async leads(abs, roots, p, hops) {
    let at = abs;
    const rest = [];
    for (;;) {
      try { at = await timeout(fs.realpath(at), 5000); break; } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        const link = await fs.lstat(at).then(st => st.isSymbolicLink(), () => false);
        if (link) {
          if (hops > 8) throw new Error(`"${p}" goes through too many links.`);
          return this.leads(path.resolve(path.dirname(at), await fs.readlink(at), ...rest), roots, p, hops + 1);
        }
        if (path.dirname(at) === at) break;
        rest.unshift(path.basename(at)); at = path.dirname(at);
      }
    }
    const full = path.join(at, ...rest);
    const root = roots.find(r => within(full, r));
    if (!root) throw new Error(`"${p}" leads outside the connected folders.`);
    const parts = path.relative(root, full).split(path.sep);
    if (parts.some(x => SKIP.has(x))) throw new Error(`"${p}" leads into a folder Pathnote skips.`);
    if (parts.some(secretDir) || SECRET_FILE.test(path.basename(full))) throw new Error(`"${p}" leads to something that looks like it holds secrets, so Pathnote won't open it.`);
  }

  // Immediate contents of a folder; folders end with "/"
  async list(dir) {
    const abs = await this.real(dir);
    const out = [];
    let entries;
    try { entries = await timeout(fs.readdir(abs, { withFileTypes: true }), 5000); } catch (e) { throw denied(e) ? Object.assign(new Error(BLOCKED), { code: 'EBLOCKED' }) : e; }
    for (const e of entries) {
      if (e.name.startsWith('.') || LOCK.test(e.name) || SKIP.has(e.name) || secretDir(e.name) || SECRET_FILE.test(e.name)) continue;
      out.push(e.isDirectory() ? e.name + '/' : e.name);
    }
    return out.sort();
  }

  async read(p) {
    const abs = await this.real(p);
    const st = await timeout(fs.stat(abs), 5000);
    if (st.isDirectory()) throw new Error(`"${p}" is a folder. Use list_files.`);
    if (st.size > MAX_READ) throw new Error(`"${p}" is ${(st.size / 1048576).toFixed(1)} MB; Pathnote reads files up to 2 MB.`);
    const buf = await timeout(fs.readFile(abs), 10000);
    if (buf.subarray(0, 8000).includes(0)) throw new Error(`"${p}" is not a text file.`);
    return buf.toString('utf8');
  }

  // Anything the AI can take in: text as is, documents as their text, pictures as images
  async open(p) {
    const abs = await this.real(p);
    if (!isDocument(abs) && !isImage(abs)) return { kind: 'text', text: await this.read(abs) };
    const st = await timeout(fs.stat(abs), 5000);
    if (st.size > MAX_DOC) throw new Error(`"${p}" is ${(st.size / 1048576).toFixed(1)} MB; Pathnote opens documents and images up to 50 MB.`);
    const buf = await timeout(fs.readFile(abs), 15000);
    if (isImage(abs)) return { kind: 'image', ...(await timeout(imageContent(abs, buf), 20000)) };
    return { kind: 'document', text: await timeout(documentText(abs, buf), 30000) };
  }

  // Document text for search, kept until the file changes
  async docText(abs) {
    const st = await fs.stat(abs);
    if (st.size > MAX_DOC) return null;
    const hit = this.docs?.get(abs);
    if (hit?.mtime === st.mtimeMs) return hit.text;
    const text = await timeout(documentText(abs, await fs.readFile(abs)), 15000);
    // newest last; past DOCS_KEPT the oldest goes, so a folder of thousands of PDFs doesn't fill memory
    (this.docs ??= new Map()).delete(abs);
    this.docs.set(abs, { mtime: st.mtimeMs, text });
    if (this.docs.size > DOCS_KEPT) this.docs.delete(this.docs.keys().next().value);
    return text;
  }

  // Plain file text for search and links, kept until the file's size or time changes. null when
  // the file is over `max` bytes. Only small files are kept, within CACHE_BYTES in all.
  // wait: ms before giving up on a read macOS is holding (see timeout); 0 waits as long as it takes.
  async fileText(abs, max, wait = 3000) {
    const st = await fs.stat(abs);
    if (st.size > max) return null;
    this.texts ??= new Map();
    this.cached ??= 0;
    const hit = this.texts.get(abs);
    if (hit?.mtime === st.mtimeMs && hit.size === st.size) return hit.text;
    const read = fs.readFile(abs, 'utf8');
    const text = await (wait ? timeout(read, wait) : read);
    // Other calls may have filled this path while we read (warm, graph and search run together at
    // startup), so count what is stored now, not what was there before the read
    const now = this.texts.get(abs);
    if (now) { this.texts.delete(abs); this.cached -= now.size; }
    if (st.size <= MAX_SEARCH && this.cached + st.size <= CACHE_BYTES) {
      this.texts.set(abs, { mtime: st.mtimeMs, size: st.size, text });
      this.cached += st.size;
    }
    return text;
  }

  // Read every text file and document once in the background, so the first search doesn't wait for them
  async warm() {
    const items = await this.walk();
    await pool(items.filter(it => it.kind === 'file' && TEXT.test(it.id)), READS, it => this.fileText(it.id, MAX_SEARCH).catch(() => {}));
    for (const it of items) {
      if (it.kind === 'file' && isDocument(it.id)) await this.docText(it.id).catch(() => {});
    }
  }

  async readOrNull(p) {
    try { return await this.read(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }

  async write(p, text) {
    const abs = await this.real(p);
    if (isDocument(abs) || isImage(abs)) throw new Error(`Pathnote can read ${path.extname(abs)} files but not write them.`);
    await timeout(fs.mkdir(path.dirname(abs), { recursive: true }), 5000);
    await timeout(fs.writeFile(abs, text, 'utf8'), 10000);
  }

  // Move a file or folder (any type) to a new path in the connected folders. Never overwrites,
  // and refuses folders that hold secret files, since those would leave the protected place.
  async move(from, to) {
    const src = await this.real(from), dst = await this.real(to);
    if (this.roots.includes(src)) throw new Error(`"${from}" is a connected folder itself; move what is inside it instead.`);
    const st = await timeout(fs.stat(src), 5000);
    if (await exists(dst)) throw new Error(`"${to}" already exists; Pathnote never overwrites.`);
    if (within(dst, src)) throw new Error(`Can't move "${from}" into itself.`);
    if (st.isDirectory()) {
      const secret = await findSecret(src);
      if (secret) throw new Error(`"${from}" holds a file that looks like a secret (${path.relative(src, secret)}), so Pathnote won't move it.`);
    }
    await timeout(fs.mkdir(path.dirname(dst), { recursive: true }), 5000);
    try {
      await fs.rename(src, dst);
    } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      // different disk (e.g. iCloud Drive): copy, then remove the original
      await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
      await fs.rm(src, { recursive: true });
    }
    return { from: src, to: dst, dir: st.isDirectory() };
  }

  async remove(p) {
    await fs.rm(await this.real(p), { force: true });
  }

  // Every folder and file under the roots, minus skipped, hidden and secret ones. Stops at MAX_NODES.
  async walk() {
    // All folders at once, so several blocked ones cost one timeout, not one each
    const per = await Promise.all(this.roots.map(async r => {
      const mine = [{ id: r, kind: 'root', parent: null }], seen = { root: false };
      try {
        await timeout(this.visit(r, mine, MAX_NODES, seen), 4000);
        return { items: mine.slice() };
      } catch (e) {
        if (e.code !== 'EBLOCKED') throw e;
        // a folder macOS won't let us read, or one that is only slow (a big iCloud or network folder):
        // that one keeps what was found in time
        return seen.root ? { items: mine.slice() } : { items: mine.slice(0, 1), blocked: r };
      }
    }));
    this.blocked = per.filter(x => x.blocked).map(x => x.blocked);
    return per.flatMap(x => x.items).slice(0, MAX_NODES);
  }

  async visit(root, items, max, seen = {}) {
    const visit = async (dir, depth) => {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (e) {
        // macOS says no straight away (EPERM) once the user has declined: the folder is blocked, not empty
        if (dir === root && denied(e)) throw Object.assign(new Error(BLOCKED), { code: 'EBLOCKED' });
        return;
      }
      if (dir === root) seen.root = true;
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (items.length >= max) return;
        if (e.name.startsWith('.') || LOCK.test(e.name) || SKIP.has(e.name) || secretDir(e.name) || SECRET_FILE.test(e.name)) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { items.push({ id: abs, kind: 'dir', parent: dir }); await visit(abs, depth + 1); }
        else if (e.isFile()) items.push({ id: abs, kind: 'file', parent: dir });
      }
    };
    await visit(root, 1);
  }

  // Text files and documents ranked by how often the query's words appear, file-name matches counted extra
  async search(query, limit = 10) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const files = (await this.walk()).filter(it => it.kind === 'file' && (TEXT.test(it.id) || isDocument(it.id))).map(it => it.id);
    // Each worker reads, scores and keeps only the hit, so only a few files' text is in memory at once
    const score = async id => {
      const text = await (isDocument(id) ? this.docText(id) : this.fileText(id, MAX_SEARCH)).catch(() => null);
      if (!text) return null;
      const lower = text.toLowerCase(), name = path.basename(id).toLowerCase();
      let score = 0;
      for (const w of words) { score += lower.split(w).length - 1; if (name.includes(w)) score += 5; }
      if (!score) return null;
      const at = Math.max(0, lower.indexOf(words.find(w => lower.includes(w)) ?? words[0]));
      return { path: id, score, snippet: text.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, ' ').trim() };
    };
    // Text files several at a time; documents one at a time, since unread ones are parsed in memory.
    // Results go back in walk order so ties sort the same as before.
    const out = new Array(files.length);
    const at = files.map((f, i) => i);
    await Promise.all([
      pool(at.filter(i => !isDocument(files[i])), READS, async i => { out[i] = await score(files[i]); }),
      pool(at.filter(i => isDocument(files[i])), 1, async i => { out[i] = await score(files[i]); }),
    ]);
    return out.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // Folder tree for the viewer, plus [[wikilinks]] between markdown notes (resolved by name, like Obsidian)
  async graph() {
    const items = await this.walk();
    const notes = items.filter(i => i.kind === 'file' && /\.md$/i.test(i.id));
    const byName = new Map(notes.map(n => [path.basename(n.id, path.extname(n.id)).toLowerCase(), n.id]));
    // Each worker returns its note's links, not its text, so memory stays at a few notes at a time.
    // No read timeout here, as before: a slow note still gets its links.
    const per = await pool(notes, READS, async n => {
      const text = await this.fileText(n.id, Infinity, 0).catch(() => null);
      const found = [];
      if (text === null) return found;
      for (const m of text.matchAll(LINK)) {
        const target = byName.get(path.basename(m[1].trim()).toLowerCase());
        if (target && target !== n.id) found.push([n.id, target]);
      }
      return found;
    });
    const links = per.flat();
    return { roots: this.roots, items, links, blocked: this.blocked, capped: items.length >= MAX_NODES };
  }
}

// Keeps the text a note had before the AI changed it, so each change can be undone.
// Stored outside the connected folders (~/.pathnote/<id>/history.jsonl) to keep them clean.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export class History {
  constructor(ws) {
    this.ws = ws;
    const id = crypto.createHash('sha1').update(ws.id).digest('hex').slice(0, 12);
    this.file = path.join(os.homedir(), '.pathnote', id, 'history.jsonl');
  }

  async all() {
    try {
      // a line cut short (Pathnote stopped while writing it) is skipped, not the end of undo for good
      return (await fs.readFile(this.file, 'utf8')).split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async append(entry) {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // after a line cut short, start on a new line so this entry isn't glued to it
    const st = await fs.stat(this.file).catch(() => null);
    let lead = '';
    if (st?.size) { const h = await fs.open(this.file, 'r'); try { const b = Buffer.alloc(1); await h.read(b, 0, 1, st.size - 1); if (b[0] !== 10) lead = '\n'; } finally { await h.close(); } }
    await fs.appendFile(this.file, lead + JSON.stringify(entry) + '\n');
  }

  // Call before changing a file. `before` is null for a file that didn't exist.
  async record(rel, before, after, kind) {
    const entry = { id: crypto.randomUUID(), t: Date.now(), path: rel, kind, before, after };
    await this.append(entry);
    return entry;
  }

  async recordMove(from, to) {
    const entry = { id: crypto.randomUUID(), t: Date.now(), path: to, kind: 'move', from, to };
    await this.append(entry);
    return entry;
  }

  // Put the note back the way it was before change `id`. Refuses if someone edited it since,
  // so a user's own later edits are never thrown away.
  async undo(id) {
    const all = await this.all();
    const entry = all.find(e => e.id === id);
    if (!entry) throw new Error('No such change.');
    if (all.some(e => e.undoes === id)) throw new Error('Already undone.');
    if (entry.kind === 'move') {
      // put it back where it was, as long as nothing has taken either place since
      await this.ws.move(entry.to, entry.from);
      await this.append({ id: crypto.randomUUID(), t: Date.now(), path: entry.from, kind: 'undo', undoes: id });
      return entry;
    }
    const now = await this.ws.readOrNull(entry.path);
    if (now !== entry.after) throw new Error(`"${entry.path}" changed after the AI wrote it, so it was left as is.`);
    if (entry.before === null) await this.ws.remove(entry.path);
    else await this.ws.write(entry.path, entry.before);
    await this.append({ id: crypto.randomUUID(), t: Date.now(), path: entry.path, kind: 'undo', undoes: id });
    return entry;
  }
}

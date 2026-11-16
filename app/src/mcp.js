// The MCP tools the AI uses. Each call does its work and tells the viewer what happened.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import path from 'node:path';
import { z } from 'zod';
import { expand } from './workspace.js';
import { refusal, findFolders } from './folders.js';

const reason = z.string().optional().describe('One short sentence on why you are doing this. Shown to the user in the Pathnote viewer.');
const text = s => ({ content: [{ type: 'text', text: s }] });
const fail = e => ({ content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });

// reload: reads the folders file again after the user lets the AI connect a folder. null: folders are fixed.
export function createServer({ ws, history, hub, version, reload = null }) {
  const server = new McpServer({ name: 'pathnote', version });
  const where = `Connected folders: ${ws.roots.join(', ') || 'none yet'}.${reload ? ' More can be added with connect_folder; list_files without a folder lists them all.' : ''} Use full paths.`;

  server.registerTool('list_files', {
    title: 'List a folder',
    description: `List what is inside a folder (folders end with "/"). Without a folder, lists the connected folders. ${where}`,
    inputSchema: { folder: z.string().optional(), reason }
  }, async ({ folder, reason }) => {
    try {
      if (!folder) return text(ws.roots.join('\n'));
      const abs = ws.resolve(folder);
      const items = await ws.list(abs);
      await hub.emit({ type: 'list', path: abs, reason });
      return text(items.join('\n') || '(empty folder)');
    } catch (e) { return fail(e); }
  });

  server.registerTool('search_files', {
    title: 'Search files',
    description: `Search text files and documents (PDF, Word, PowerPoint, Excel, Hangul) in the connected folders for words. Returns the best matching paths with a snippet each. ${where}`,
    inputSchema: { query: z.string().describe('Words to look for'), reason }
  }, async ({ query, reason }) => {
    try {
      const hits = await ws.search(query);
      await hub.emit({ type: 'search', query, hits: hits.map(h => h.path), reason });
      return text(hits.length ? hits.map(h => `${h.path}\n  ${h.snippet}`).join('\n') : 'No matches.');
    } catch (e) { return fail(e); }
  });

  server.registerTool('read_file', {
    title: 'Read a file',
    description: `Read a file: text files (up to 2 MB) as they are, PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx) and Hangul (.hwpx) as their text, and pictures (.png, .jpg, .gif, .webp, .heic) as images you can see. ${where}`,
    inputSchema: { path: z.string(), reason }
  }, async ({ path, reason }) => {
    try {
      const abs = ws.resolve(path);
      const file = await ws.open(abs);
      await hub.emit({ type: 'read', path: abs, reason });
      if (file.kind === 'image') return { content: [{ type: 'image', data: file.data, mimeType: file.mimeType }] };
      return text(file.text);
    } catch (e) { return fail(e); }
  });

  server.registerTool('write_file', {
    title: 'Write a file',
    description: `Create a text file, or replace a text file's whole text (not documents or pictures). The user can undo this from the Pathnote viewer. In markdown notes, link the notes you used with [[Note name]]. ${where}`,
    inputSchema: { path: z.string(), content: z.string(), reason }
  }, async ({ path, content, reason }) => {
    try {
      const abs = ws.resolve(path);
      const before = await ws.readOrNull(abs);
      const change = await history.record(abs, before, content, before === null ? 'create' : 'write');
      await ws.write(abs, content);
      await hub.emit({ type: 'write', path: abs, created: before === null, changeId: change.id, reason });
      return text(`${before === null ? 'Created' : 'Replaced'} ${abs}.`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('edit_file', {
    title: 'Edit a file',
    description: `Replace one exact piece of text in a file. \`find\` must appear exactly once. The user can undo this from the Pathnote viewer. ${where}`,
    inputSchema: { path: z.string(), find: z.string().min(1), replace: z.string(), reason }
  }, async ({ path, find, replace, reason }) => {
    try {
      const abs = ws.resolve(path);
      const before = await ws.read(abs);
      const count = before.split(find).length - 1;
      if (count !== 1) throw new Error(count ? `The text appears ${count} times; include more of it so it is unique.` : 'The text was not found.');
      const after = before.replace(find, () => replace);
      const change = await history.record(abs, before, after, 'edit');
      await ws.write(abs, after);
      await hub.emit({ type: 'edit', path: abs, changeId: change.id, reason });
      return text(`Edited ${abs}.`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('move_file', {
    title: 'Move a file or folder',
    description: `Move or rename a file or folder (any type, including pictures and videos) to a new full path. Missing parent folders are created. Never overwrites an existing path. The user can undo this from the Pathnote viewer. ${where}`,
    inputSchema: { from: z.string(), to: z.string(), reason }
  }, async ({ from, to, reason }) => {
    try {
      const moved = await ws.move(from, to);
      const change = await history.recordMove(moved.from, moved.to);
      await hub.emit({ type: 'move', path: moved.to, from: moved.from, dir: moved.dir, changeId: change.id, reason });
      return text(`Moved ${moved.from} to ${moved.to}.`);
    } catch (e) { return fail(e); }
  });

  server.registerTool('get_blueprint', {
    title: 'Blueprint of recorded work',
    description: 'A blueprint of a piece of AI work Pathnote recorded from Claude Code: the goal, what it needed first, the steps in plain words, the sites and services it reached, what it produced and the pitfalls it hit, as Markdown with Claude Code skill front matter. Use it when the user wants work turned into a plan or skill another agent can repeat. By default it covers the most recent session from its last request on. Polish it so another agent can follow it on first read: keep the front matter and the marks on steps that leave something outside this computer.',
    inputSchema: {
      session: z.string().optional().describe('Claude Code session id; the most recent one if left out'),
      whole: z.boolean().optional().describe('The whole session instead of only from its last request'),
      lang: z.enum(['en', 'ko']).optional()
    }
  }, async ({ session, whole, lang }) => {
    try {
      // the process that shows the viewer follows Claude Code's logs; ask it
      const port = hub.forwardTo || hub.port;
      const get = async q => {
        const res = await fetch(`http://127.0.0.1:${port}/api/blueprint?${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(30000) });
        const r = await res.json();
        if (!res.ok) throw new Error(r.error);
        return r;
      };
      const q = { lang: lang || 'en', ...(session ? { session } : {}) };
      let r = await get(q);
      if (!whole && r.requests.length) r = await get({ ...q, session: r.session, from: r.requests[r.requests.length - 1].t });
      return text(r.markdown);
    } catch (e) { return fail(e); }
  });

  if (reload) server.registerTool('connect_folder', {
    title: 'Connect a folder',
    description: 'Ask the user to let Pathnote use another folder on this computer, for files outside the connected folders. Give a full path (~ is the home folder), or just the folder\'s name to look for it in the home folder. The user says yes or no in the Pathnote viewer, which opens by itself; this waits for the answer for up to 3 minutes.',
    inputSchema: { folder: z.string().describe('Full path, or the folder\'s name'), reason }
  }, async ({ folder, reason }) => {
    try {
      let abs = expand(folder);
      if (!path.isAbsolute(abs)) {
        const found = await findFolders(abs);
        if (!found.length) return fail(new Error(`No folder named "${folder}" in the home folder. Ask the user where it is and use its full path.`));
        if (found.length > 1) return text(`Several folders are named "${folder}":\n${found.join('\n')}\nAsk the user which one, then call connect_folder with its full path.`);
        abs = found[0];
      }
      abs = path.resolve(abs);
      const no = refusal(abs);
      if (no) return fail(new Error(no));
      const root = ws.rootOf(abs);
      if (root) return text(`${abs} is already connected${root === abs ? '' : ` (inside ${root})`}.`);
      const yes = await hub.ask(abs, reason);
      if (yes === null) return text(`The user didn't answer in the Pathnote viewer, so ${abs} is not connected.`);
      if (!yes) return text(`The user declined, so ${abs} is not connected.`);
      reload();
      return text(`Connected ${abs}. Connected folders now: ${ws.roots.join(', ')}.`);
    } catch (e) { return fail(e); }
  });

  return server;
}

// Everything Claude Code does, not only what it does through Pathnote's tools: its session logs
// (~/.claude/projects/<project>/<session>.jsonl) record each request, reply and tool call as it happens.
// We follow the logs of sessions working in the connected folders and turn each record into a viewer event.
// The logs are only read, and what we take from them goes only to the local viewer page.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { expand } from './workspace.js';

// Claude Code keeps them under CLAUDE_CONFIG_DIR when that is set
export const LOGS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
const TEXT_MAX = 400; // characters of a request, reply or command shown in the viewer
// Logs reach hundreds of MB (tool results hold whole files and pictures), so new text is read this much at a time
const CHUNK = 4 * 1024 * 1024;
// Pathnote's own tools already report to the viewer (with undo), so their log entries are skipped
const OWN = /^mcp__pathnote__/;

const clip = s => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX - 1) + '…' : s; };
const host = u => { try { return new URL(u).host; } catch { return ''; } };

// What a tool call that isn't about a file looks like on the map: the place it goes to, the call as it
// was made (text, reason: for developer mode), and `plain`, what it did in words, where the call carries
// some (Claude writes a description for each command and browser action). The viewer words the rest.
// quiet: calls about the conversation itself (task lists, loading tools), shown only in developer mode.
const BROWSER = /^(claude-in-chrome|Claude_Browser|playwright|puppeteer)$/;
// (the Claude app's end-of-turn summary only repeats Claude's answer, which is shown anyway)
const QUIET = /^(ToolSearch|TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|TaskOutput|ExitPlanMode|EnterPlanMode)$|^mcp__ccd_(turn__|view__|session_mgmt__list|sidebar__)/;
function step(name, input = {}) {
  const quiet = QUIET.test(name) || undefined;
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell' || name === 'Monitor') return { place: 'shell', text: input.command || input.bash_id || name, reason: input.description, plain: input.description, quiet };
  if (name === 'WebSearch') return { place: 'web', text: input.query, plain: input.query };
  if (name === 'WebFetch') return { place: 'web', text: input.url, reason: input.prompt && clip(input.prompt), plain: host(input.url) };
  if (name === 'Agent' || name === 'Task') return { place: 'agent', text: input.description || clip(input.prompt), reason: input.subagent_type, plain: input.description };
  // files outside the connected folders: by name, since they aren't on the map
  if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) { const f = input.file_path || input.notebook_path; return { place: 'files', text: f || name, plain: f && path.basename(f) }; }
  if (name === 'Grep' || name === 'Glob' || name === 'LS') return { place: 'files', text: input.pattern || input.path || name, reason: input.path, plain: input.pattern || (input.path && path.basename(input.path)) };
  if (name === 'Skill') return { place: 'claude', text: name, reason: summary(input), plain: input.skill };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp && BROWSER.test(mcp[1])) {
    // one browser action, or several in a batch: Claude's own summary of each
    const acts = mcp[2] === 'browser_batch' ? (input.actions || []).map(a => a.input || {}) : [input];
    const said = acts.map(a => a.action_summary || (a.url && host(a.url))).filter(Boolean);
    return { place: 'browser', text: mcp[2], reason: summary(input), plain: said.length ? clip(said.join(', ')) : undefined };
  }
  if (mcp) return { place: mcp[1] === 'scheduled-tasks' ? 'schedule' : `app:${mcp[1]}`, text: mcp[2], reason: summary(input), plain: words(mcp[2]), quiet };
  return { place: 'claude', text: name, reason: summary(input), plain: words(name), quiet };
}

// Where a step reaches outside this computer: the sites and services (hosts) it talks to, from the
// addresses in it and from tools known to talk to one. Scripts that call an API from inside (python
// upload.py) only show once their output names an address (see record()).
const URLS = /https?:\/\/[^\s'"`<>)\]},]+/g;
const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/;
const CLIS = [
  [/(^|[\s;&|(])gh\s/, 'github.com'], [/\bgit\s+(push|pull|fetch|clone)\b/, 'git'], [/\bwrangler\b/, 'cloudflare.com'],
  [/\bnpm\s+publish\b/, 'npmjs.com'], [/\bvercel\b/, 'vercel.com'], [/\bnetlify\b/, 'netlify.com'], [/\bfirebase\b/, 'firebase.google.com'],
  [/\bgcloud\b/, 'cloud.google.com'], [/(^|[\s;&|(])aws\s/, 'aws.amazon.com'], [/\b(fastlane|altool|notarytool)\b/, 'apple.com'], [/\bdocker\s+push\b/, 'docker.com']
];
export function hostsIn(text) {
  const out = new Set();
  for (const u of String(text || '').slice(0, 20000).match(URLS) || []) { const h = host(u).replace(/^www\./, ''); if (h && !LOCAL.test(h.replace(/:\d+$/, ''))) out.add(h.replace(/:\d+$/, '')); }
  return [...out];
}
function reach(name, input, st) {
  if (st.place === 'shell') {
    const cmd = String(input.command || ''), found = new Set(hostsIn(cmd));
    for (const [re, h] of CLIS) if (re.test(cmd)) found.add(h);
    const ssh = /\b(?:ssh|scp|rsync)\b[^;&|]*?(?:[\w.-]+@)?([a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,})/i.exec(cmd);
    if (ssh) found.add(ssh[1].toLowerCase());
    return [...found];
  }
  if (name === 'WebFetch') return hostsIn(input.url);
  if (st.place === 'browser') return hostsIn(JSON.stringify(input));
  if (st.place === 'files' || st.quiet) return [];
  return hostsIn(JSON.stringify(input));
}

// A step that leaves a mark outside this computer: publishing, deploying, uploading, sending, deleting
const OUT_CMD = /\b(git\s+push|npm\s+publish|wrangler\s+(pages\s+)?deploy|docker\s+push|firebase\s+deploy|fastlane|altool|notarytool)\b|\bgh\s+(pr\s+(create|merge)|release\s+create|repo\s+create|issue\s+create)\b|\bvercel\b.*--prod|\bcurl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|\s(-d|--data\S*|-F|--form)\s)/i;
// Claude's description starts with what it does: "Upload 7 videos", not "Show upload logs"
const OUT_VERB = /^(re-?)?(upload|deploy|publish|post|send|submit|delete|remove|push|release|reply|comment|email|tweet)\b|올리|올려|배포|게시|보내|삭제|제출|댓글/i;
// another app's tool that sends something out (send_email, post_message, delete_file), not one that only
// changes something on this computer (update_scheduled_task)
const OUT_TOOL = /(^|_)(send|post|upload|publish|delete|reply|comment|share|tweet|email)(_|$)/i;
function outward(name, input, st) {
  if (st.place === 'shell') return OUT_CMD.test(String(input.command || '')) || OUT_VERB.test(String(input.description || '').trim());
  if (st.place === 'browser') return String(st.plain || '').split(', ').some(p => OUT_VERB.test(p.trim()));
  if (/^app:/.test(st.place)) return OUT_TOOL.test(st.text || '');
  return false;
}

// update_scheduled_task -> update scheduled task
const words = s => s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

// One line from a tool's input: its first short string values
function summary(input) {
  const vals = Object.values(input || {}).filter(v => typeof v === 'string' && v.trim()).map(clip);
  return vals.length ? clip(vals.slice(0, 2).join(', ')) : undefined;
}

// The text a person typed. Claude Code also logs notifications, slash-command wrappers and
// reminders as user messages; those start with a tag and are left out.
function said(content) {
  const parts = typeof content === 'string' ? [content] : (content || []).filter(b => b.type === 'text').map(b => b.text);
  const s = parts.join('\n').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  // Claude Code's own notes in the user's place: a summary when a long conversation is carried on, a stop
  if (/^This session is being continued from a previous conversation|^\[Request interrupted by user/.test(s)) return '';
  return s && !s.startsWith('<') ? clip(s) : '';
}

export class ClaudeCode {
  // emit: hub.emit. dir: where Claude Code keeps its logs (tests point it elsewhere)
  constructor(ws, emit, { dir = LOGS } = {}) {
    this.ws = ws;
    this.emit = emit;
    this.dir = dir;
    this.files = new Map(); // log file -> { at: bytes read, rest: unfinished last line }
    this.sessions = new Map(); // session id -> { on: shows in the viewer, title, uses: tool calls waiting for a result }
  }

  // Follow the logs from now on: what was written before Pathnote started stays out
  async start() {
    if (this.watcher) return;
    // A log that appears later can start with an earlier conversation (a resumed or forked session copies it in):
    // records from before now are skipped, so they don't flood the viewer as if they were happening now
    this.since = Date.now() - 5000;
    for (const f of await this.logs(this.dir)) {
      try { this.files.set(f, { at: (await fsp.stat(f)).size, rest: '', dec: new StringDecoder('utf8') }); } catch {}
    }
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_, name) => {
        if (name && name.endsWith('.jsonl')) this.read(path.join(this.dir, name)).catch(() => {});
      });
      this.watcher.on('error', () => {});
    } catch {
      // no Claude Code on this computer (or no recursive watching here): nothing to follow
    }
  }

  stop() { this.watcher?.close(); this.watcher = null; }

  async logs(dir) {
    const out = [];
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...await this.logs(abs));
      else if (e.name.endsWith('.jsonl')) out.push(abs);
    }
    return out;
  }

  // Read what was added to a log since last time, one record per line. Calls for the same file run one after another.
  read(file) {
    const f = this.files.get(file) || { at: 0, rest: '', dec: new StringDecoder('utf8') };
    this.files.set(file, f);
    f.queue = (f.queue || Promise.resolve()).then(async () => {
      const st = await fsp.stat(file);
      if (st.size < f.at) { f.at = 0; f.rest = ''; f.dec = new StringDecoder('utf8'); } // rewritten from the start
      if (st.size === f.at) return;
      const h = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(Math.min(CHUNK, st.size - f.at));
        while (f.at < st.size) {
          const { bytesRead } = await h.read(buf, 0, Math.min(buf.length, st.size - f.at), f.at);
          if (!bytesRead) break;
          f.at += bytesRead;
          // the decoder keeps a character cut in two by the chunk's end for the next chunk
          const lines = (f.rest + f.dec.write(buf.subarray(0, bytesRead))).split('\n');
          f.rest = lines.pop();
          for (const l of lines) {
            if (!wanted(l)) continue;
            let r;
            try { r = JSON.parse(l); } catch { continue; }
            // one odd record must not cost the rest of the chunk: the read position has already moved on
            try { await this.record(r); } catch {}
          }
        }
      } finally { await h.close(); }
    }).catch(() => {});
    return f.queue;
  }

  // Everything one session did, from the start of its log and its subagents' logs: for a blueprint.
  // Read with a fresh reader, so the live one's place in each log isn't disturbed.
  async history(id) {
    if (!/^[\w-]{8,}$/.test(String(id))) throw new Error('Unknown session.');
    const files = (await this.logs(this.dir)).filter(f => path.basename(f) === `${id}.jsonl` || f.includes(`${path.sep}${id}${path.sep}subagents${path.sep}`));
    if (!files.length) throw new Error('Claude Code has no log for that session.');
    const events = [];
    const all = new ClaudeCode(this.ws, e => events.push(e), { dir: this.dir });
    all.since = 0;
    all.sessions.set(id, { on: true, title: null, uses: new Map(), steps: new Map(), page: null });
    for (const f of files) await all.read(f);
    // the main log and its subagents' logs, in the order things happened
    return { events: events.filter(e => e.session === id).sort((a, b) => a.t - b.t), title: all.sessions.get(id).title };
  }

  // Inside a connected folder: on the map
  inside(p, cwd) {
    if (!p) return null;
    const abs = path.resolve(cwd || '/', expand(p));
    const root = this.ws.rootOf(abs);
    // spelled like the connected folder, as the map has it, whatever case the log used
    return root ? root + abs.slice(root.length) : null;
  }

  session(r) {
    let s = this.sessions.get(r.sessionId);
    if (!s) this.sessions.set(r.sessionId, s = { on: false, title: null, uses: new Map(), steps: new Map(), page: null });
    // A session shows once it works in a connected folder, or touches a file in one
    if (!s.on && r.cwd && this.ws.rootOf(path.resolve(r.cwd))) s.on = true;
    return s;
  }

  async record(r) {
    if (!r || !r.sessionId) return;
    if (r.timestamp && this.since && Date.parse(r.timestamp) < this.since) return;
    const s = this.session(r);
    if (r.type === 'custom-title') { s.title = r.customTitle || s.title; return; }
    const m = r.message;
    if (!m || (r.type !== 'user' && r.type !== 'assistant')) return;
    const base = { source: 'claude-code', session: r.sessionId, title: s.title || undefined, agent: r.isSidechain || undefined, t: Date.parse(r.timestamp) || Date.now() };
    const send = e => this.emit({ ...base, ...e });

    if (r.type === 'assistant') {
      for (const b of m.content || []) {
        if (b.type === 'text' && s.on && b.text.trim()) await send({ type: 'say', text: clip(b.text) });
        if (b.type !== 'tool_use' || OWN.test(b.name)) continue;
        const input = b.input || {};
        const target = this.target(b.name, input, r.cwd);
        // Calls on files in the connected folders wait for their result, so the map shows only what really happened
        if (target) { s.on = true; s.uses.set(b.id, { name: b.name, input, cwd: r.cwd, target }); continue; }
        if (!s.on) continue;
        const st = step(b.name, input);
        let hosts = reach(b.name, input, st);
        // browser actions without an address happen on the page the session last opened
        if (st.place === 'browser') { if (hosts.length) s.page = hosts[hosts.length - 1]; else if (s.page) hosts = [s.page]; }
        if (/^(shell|app:)/.test(st.place)) { s.steps.set(b.id, hosts); if (s.steps.size > 200) s.steps.delete(s.steps.keys().next().value); }
        await send({ type: 'step', id: b.id, tool: b.name, ...st, hosts: hosts.length ? hosts : undefined, out: outward(b.name, input, st) || undefined });
      }
      return;
    }

    if (typeof m.content === 'string' || !(m.content || []).some(b => b.type === 'tool_result')) {
      const text = !r.isMeta && !r.isSidechain && said(m.content);
      if (text && s.on) await send({ type: 'prompt', text });
      return;
    }
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue;
      // what a command or app printed can name the services it talked to (an API's address in its output)
      const was = s.steps.get(b.tool_use_id);
      if (was) {
        s.steps.delete(b.tool_use_id);
        const more = b.is_error ? [] : hostsIn(resultText(b.content)).filter(h => !was.includes(h));
        if (more.length && s.on) await send({ type: 'reach', id: b.tool_use_id, hosts: more.slice(0, 5) });
      }
      const use = s.uses.get(b.tool_use_id);
      s.uses.delete(b.tool_use_id);
      if (b.is_error) {
        if (!s.on) continue;
        // a file call that failed never reached the map, so it shows as a failed step instead
        if (use) await send({ type: 'step', id: b.tool_use_id, tool: use.name, place: 'files', text: use.target, plain: path.basename(use.target) });
        await send({ type: 'fail', id: b.tool_use_id, text: clip(resultText(b.content)) });
        continue;
      }
      if (!use) continue;
      const res = r.toolUseResult || {}, { name: tool, target: p } = use;
      if (tool === 'Read') await send({ type: 'read', path: p, tool });
      else if (tool === 'Write') await send({ type: 'write', path: p, created: res.type === 'create', tool });
      else if (tool === 'LS') await send({ type: 'list', path: p, tool });
      else if (tool === 'Grep' || tool === 'Glob') {
        const hits = (res.filenames || []).map(f => this.inside(f, use.cwd)).filter(Boolean);
        await send({ type: 'search', query: use.input.pattern, hits, tool });
      } else await send({ type: 'edit', path: p, tool });
    }
  }

  // The file or folder in a connected folder that a file tool works on, or null
  target(name, input, cwd) {
    if (['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return this.inside(input.file_path || input.notebook_path, cwd);
    if (['Grep', 'Glob', 'LS'].includes(name)) return this.inside(input.path || cwd, cwd);
    return null;
  }
}

// Most of a log is records Pathnote doesn't use (API requests, snapshots, hook output). Those start with their type,
// so they are skipped before parsing; messages start with other keys and are always parsed
const SKIP = /^\{"type":"(?!user"|assistant"|custom-title")/;
const wanted = l => l.length > 2 && !SKIP.test(l);

function resultText(c) {
  if (typeof c === 'string') return c;
  return (c || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
}

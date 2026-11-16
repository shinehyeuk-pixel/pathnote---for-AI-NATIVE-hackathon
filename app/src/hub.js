// Local viewer server: serves the graph page and streams what the AI does to it.
// Claude Desktop may start several Pathnote processes; the first one for a set of folders owns the
// viewer port and the others forward their events to it.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveBlueprint } from './blueprint.js';
import { listSkills, readSkill, parseSkill, updateSkill } from './skills.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer', 'index.html');
const KEEP = 500;
const ASK_WAIT = 3 * 60 * 1000; // how long the AI waits for the user to answer a folder request

export class Hub {
  // open: called with the viewer URL the first time the AI does something while no viewer page is
  // connected, so the map shows up without the user looking for it. null turns this off.
  // reveal: shows a file in Finder (Explorer, the file manager) when the user asks from the viewer.
  // own: called each time this process takes the viewer port, so whatever only the owner should run
  // (following Claude Code's logs) runs in exactly one process.
  // connect: adds a folder the user agreed to in the viewer (to the folders file). null: the AI can't ask.
  // blueprint: (session, { lang, from, to }) => { blueprint, markdown, requests } for one recorded session (blueprint.js)
  constructor(ws, history, port, { open = null, reveal = revealFile, version = null, own = null, connect = null, blueprint = null, skills = {} } = {}) {
    this.ws = ws;
    this.skills = skills; // where Claude Code skills are: { home, env }, the real ones by default
    this.blueprint = blueprint;
    this.connect = connect;
    this.opener = open;
    this.asks = new Map(); // folder requests: id -> { path, answer: true, false, or null while waiting }
    this.own = own;
    this.version = version;
    this.open = open;
    this.reveal = reveal;
    this.history = history;
    this.port = port;
    this.events = [];
    this.clients = new Set();
    this.forwardTo = null; // port of another process that owns the viewer
    this.boot = Date.now().toString(36); // with seq, lets the page skip events it already has
    this.seq = 0;
  }

  // Own a port for these folders, or find the process that already does. Returns the viewer URL.
  async start() {
    for (let port = this.port; port < this.port + 10; port++) {
      const other = await this.info(port);
      if (other?.id === this.ws.id) { this.forwardTo = port; return `http://127.0.0.1:${port}`; }
      if (other) continue;
      try {
        await this.listen(port);
        this.port = port;
        this.own?.();
        return `http://127.0.0.1:${port}`;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
      }
    }
    throw new Error(`No free port between ${this.port} and ${this.port + 9}.`);
  }

  async info(port) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(500) });
      const body = await res.json();
      return body.app === 'pathnote' ? body : null;
    } catch {
      return null;
    }
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res).catch(e => send(res, 500, { error: e.message })));
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { this.server = server; resolve(); });
    });
  }

  async emit(event, retried = false) {
    const e = { t: Date.now(), ...event };
    if (this.forwardTo) {
      try {
        await fetch(`http://127.0.0.1:${this.forwardTo}/api/event`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${this.forwardTo}` },
          body: JSON.stringify(e), signal: AbortSignal.timeout(1000)
        });
        return;
      } catch (e) {
        // A busy viewer process answers late; it is still there and may have the event, so don't take over
        if (e?.name === 'TimeoutError') return;
        // The process that owned the viewer has quit: take the port over and keep showing events
        this.forwardTo = null;
        if (retried) return;
        try { await this.start(); } catch { return; }
        if (this.forwardTo) return this.emit(event, true);
      }
    }
    this.broadcast(e);
  }

  // The AI asks to use another folder. The viewer shows the request (opening the page if none is open)
  // and the user says yes or no there. Resolves to true or false, or null if nobody answered in time.
  async ask(abs, reason, wait = ASK_WAIT) {
    const until = Date.now() + wait;
    let id;
    if (this.forwardTo) {
      const res = await this.call('POST', '/api/ask', { path: abs, reason });
      if (!res.ok) throw new Error((await res.json()).error || 'The viewer could not take the request.');
      ({ id } = await res.json());
    } else {
      if (!this.connect) throw new Error('This Pathnote can\'t add folders.');
      id = this.request(abs, reason);
    }
    while (Date.now() < until) {
      const a = this.forwardTo ? (await (await this.call('GET', `/api/ask?id=${id}`)).json()).answer : this.asks.get(id)?.answer;
      if (a === true || a === false) return a;
      await new Promise(r => setTimeout(r, 500));
    }
    if (!this.forwardTo) this.answer(id, null);
    return null;
  }

  request(abs, reason) {
    const id = crypto.randomUUID();
    this.asks.set(id, { path: abs, answer: null });
    setTimeout(() => this.answer(id, null), ASK_WAIT + 5000).unref(); // the AI stopped waiting by then
    this.broadcast({ t: Date.now(), type: 'ask', id, path: abs, reason });
    // the user has to see it to answer, so the page opens even if it was opened before
    if (this.opener && this.clients.size === 0) this.opener(`http://127.0.0.1:${this.port}`);
    return id;
  }

  answer(id, yes) {
    const ask = this.asks.get(id);
    if (!ask || ask.answer !== null) return false;
    if (yes) this.connect(ask.path);
    ask.answer = yes ?? false; // null: nobody answered in time, which counts as no

    this.broadcast({ t: Date.now(), type: 'answered', id, path: ask.path, yes });
    return true;
  }

  call(method, url, data) {
    return fetch(`http://127.0.0.1:${this.forwardTo}${url}`, {
      method, headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${this.forwardTo}` },
      body: data ? JSON.stringify(data) : undefined, signal: AbortSignal.timeout(2000)
    });
  }

  broadcast(event) {
    const e = { ...event, key: `${this.boot}:${++this.seq}` };
    this.events.push(e);
    if (this.events.length > KEEP) this.events.shift();
    for (const res of this.clients) res.write(`data: ${JSON.stringify(e)}\n\n`);
    // Once per process: a page left open from an earlier run reconnects by itself, so it counts
    if (this.open && this.clients.size === 0) {
      const open = this.open;
      this.open = null;
      open(`http://127.0.0.1:${this.port}`);
    }
  }

  // Only pages served from this port may call the API, so other websites can't trigger undo.
  allowed(req) {
    const hosts = [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
    if (!hosts.includes(req.headers.host)) return false;
    const origin = req.headers.origin;
    return req.method === 'GET' ? !origin || hosts.some(h => origin === `http://${h}`) : hosts.some(h => origin === `http://${h}`);
  }

  async handle(req, res) {
    if (!this.allowed(req)) return send(res, 403, { error: 'forbidden' });
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(await fs.readFile(PAGE));
    }
    if (req.method === 'GET' && url.pathname === '/api/info') return send(res, 200, { app: 'pathnote', version: this.version, id: this.ws.id, roots: this.ws.roots });
    if (req.method === 'GET' && url.pathname === '/api/graph') return send(res, 200, await this.ws.graph());
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.flushHeaders(); // the page counts as connected before the first event
      for (const e of this.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      this.clients.add(res);
      req.on('close', () => this.clients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/event') {
      this.broadcast(await body(req));
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/reveal') {
      const { path: p } = await body(req);
      try {
        // in the connected folders, or a file outside them that the AI touched (it is in the events)
        let abs;
        try { abs = await this.ws.real(p); } catch (e) {
          const seen = typeof p === 'string' && path.isAbsolute(p) && this.events.some(x => x.text === p || x.path === p);
          if (!seen) throw e;
          abs = p;
        }
        await fs.access(abs);
        this.reveal(abs);
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 404, { error: e.code === 'ENOENT' ? 'This file is no longer there.' : e.message });
      }
    }
    // A folder request from another Pathnote process, and its answer from the viewer page
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      if (!this.connect) return send(res, 409, { error: 'This Pathnote was started with fixed folders.' });
      const { path: p, reason } = await body(req);
      return send(res, 200, { id: this.request(p, reason) });
    }
    if (req.method === 'GET' && url.pathname === '/api/ask') return send(res, 200, { answer: this.asks.get(url.searchParams.get('id'))?.answer ?? null });
    if (req.method === 'POST' && url.pathname === '/api/answer') {
      const { id, yes } = await body(req);
      return this.answer(id, !!yes) ? send(res, 200, { ok: true }) : send(res, 409, { error: 'This request was already answered.' });
    }
    // Blueprints: one recorded session as a plan another agent can follow, and saving it where agents look
    if (req.method === 'GET' && url.pathname === '/api/blueprint') {
      if (!this.blueprint) return send(res, 409, { error: 'This Pathnote has no Claude Code records.' });
      const session = url.searchParams.get('session') || [...this.events].reverse().find(e => e.session)?.session;
      if (!session) return send(res, 404, { error: 'No AI session has been seen yet.' });
      const q = k => Number(url.searchParams.get(k)) || undefined;
      try { return send(res, 200, { session, ...(await this.blueprint(session, { lang: url.searchParams.get('lang') || 'en', from: q('from'), to: q('to') })) }); } catch (e) { return send(res, 404, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/blueprint/save') {
      try { return send(res, 200, saveBlueprint(await body(req))); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    // Claude Code skills, opened as the same mind map, and an edit saved over the skill (the old one kept)
    if (req.method === 'GET' && url.pathname === '/api/skills') return send(res, 200, { skills: listSkills(this.skills).map(({ name, description }) => ({ name, description })) });
    if (req.method === 'GET' && url.pathname === '/api/skill') {
      try { const { name, text, blueprint } = readSkill(url.searchParams.get('name'), this.skills); return send(res, 200, { name, text, blueprint }); } catch (e) { return send(res, 404, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/skill/parse') {
      const { text, name } = await body(req);
      return send(res, 200, { blueprint: parseSkill(String(text || '').slice(0, 200000), name) });
    }
    if (req.method === 'POST' && url.pathname === '/api/skill/update') {
      try { return send(res, 200, updateSkill(await body(req), this.skills)); } catch (e) { return send(res, 400, { error: e.message }); }
    }
    if (req.method === 'POST' && url.pathname === '/api/undo') {
      const { id } = await body(req);
      try {
        const entry = await this.history.undo(id);
        this.broadcast({ t: Date.now(), type: 'undo', path: entry.kind === 'move' ? entry.to : entry.path, changeId: id, created: entry.before === null || entry.kind === 'move', back: entry.kind === 'move' ? entry.from : undefined });
        return send(res, 200, { ok: true });
      } catch (e) {
        return send(res, 409, { error: e.message });
      }
    }
    send(res, 404, { error: 'not found' });
  }
}

// Opens a URL in the default browser. Errors are ignored: the URL is also in the client's MCP log.
export function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

// Selects a file in the system file manager. Errors are ignored.
export function revealFile(abs) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', abs]]
    : process.platform === 'win32' ? ['explorer', [`/select,${abs}`]]
    : ['xdg-open', [path.dirname(abs)]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let s = '';
  for await (const chunk of req) { s += chunk; if (s.length > 1e6) throw new Error('too large'); }
  return JSON.parse(s || '{}');
}

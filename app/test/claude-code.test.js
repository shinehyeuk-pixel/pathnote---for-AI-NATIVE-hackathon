// Following Claude Code's session logs: everything a session in the connected folders does shows up,
// files on the map and the rest as steps; other sessions and what came before Pathnote started stay out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.js';
import { ClaudeCode, hostsIn } from '../src/claude-code.js';

const dirs = [];
const tmp = async name => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), name))); dirs.push(d); return d; };
after(() => Promise.all(dirs.map(d => fs.rm(d, { recursive: true, force: true }))));
const line = r => JSON.stringify({ timestamp: new Date().toISOString(), ...r }) + '\n';
const use = (sessionId, cwd, id, name, input) => line({ type: 'assistant', sessionId, cwd, message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (sessionId, cwd, id, toolUseResult, is_error) => line({ type: 'user', sessionId, cwd, toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: is_error ? 'Exit code 1' : 'ok', is_error }] } });
const until = async (fn, ms = 3000) => { const end = Date.now() + ms; while (!fn()) { if (Date.now() > end) throw new Error('timed out'); await new Promise(r => setTimeout(r, 20)); } };

test('a Claude Code session in the folders shows its requests, replies, files and other steps', async () => {
  const notes = await tmp('pathnote-cc-notes-'), logs = await tmp('pathnote-cc-logs-'), elsewhere = await tmp('pathnote-cc-else-');
  const project = path.join(logs, 'project');
  await fs.mkdir(project);
  const log = path.join(project, 's1.jsonl'), other = path.join(project, 's2.jsonl');
  await fs.writeFile(log, line({ type: 'user', sessionId: 's1', cwd: notes, message: { content: 'before Pathnote started' } }));
  await fs.writeFile(path.join(notes, 'a.md'), 'x');

  const events = [];
  const cc = new ClaudeCode(new Workspace([notes]), e => events.push(e), { dir: logs });
  await cc.start();
  await fs.appendFile(log, [
    line({ type: 'custom-title', sessionId: 's1', customTitle: 'Plan the quarter' }),
    line({ type: 'user', sessionId: 's1', cwd: notes, message: { content: 'Write the plan' } }),
    line({ type: 'user', sessionId: 's1', cwd: notes, message: { content: '<task-notification>done</task-notification>' } }),
    line({ type: 'assistant', sessionId: 's1', cwd: notes, message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'On it.' }] } }),
    use('s1', notes, 't1', 'Read', { file_path: path.join(notes, 'a.md') }),
    result('s1', notes, 't1', { type: 'text' }),
    use('s1', notes, 't2', 'Bash', { command: 'ls -la', description: 'List files' }),
    result('s1', notes, 't2', {}, true),
    use('s1', notes, 't3', 'WebSearch', { query: 'okr examples' }),
    use('s1', notes, 't4', 'mcp__obsidian__search_notes', { query: 'goals' }),
    use('s1', notes, 't5', 'mcp__pathnote__read_file', { path: 'a.md' }),
    use('s1', notes, 't6', 'Write', { file_path: path.join(notes, 'plan.md'), content: 'y' }),
    result('s1', notes, 't6', { type: 'create' }),
    use('s1', notes, 't7', 'Grep', { pattern: 'goal' }),
    result('s1', notes, 't7', { filenames: [path.join(notes, 'a.md'), path.join(elsewhere, 'b.md')] }),
    use('s1', notes, 't9', 'mcp__claude-in-chrome__browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://studio.youtube.com/x' } }, { name: 'computer', input: { action: 'left_click', action_summary: 'Opens the upload dialog' } }] }),
    use('s1', notes, 't10', 'mcp__ccd_turn__update_plan', { advance: true }),
    use('s1', notes, 't8', 'Read', { file_path: path.join(notes, 'missing.md') }),
    result('s1', notes, 't8', {}, true),
  ].join(''));
  // a session working somewhere else stays out
  await fs.writeFile(other, use('s2', elsewhere, 'u1', 'Bash', { command: 'secret stuff' }));
  // the watcher picks the new lines up; a busy machine can take a while to report them
  try { await until(() => events.some(e => e.id === 't8' && e.type === 'fail'), 10000); } finally { cc.stop(); }
  await cc.read(other);

  const brief = events.map(e => [e.type, e.place || e.path?.replace(notes, '~') || e.query || e.text, e.tool].filter(Boolean).join(' '));
  assert.deepEqual(brief, [
    'prompt Write the plan',
    'say On it.',
    'read ~/a.md Read',
    'step shell Bash',
    'fail Exit code 1',
    'step web WebSearch',
    'step app:obsidian mcp__obsidian__search_notes',
    'write ~/plan.md Write',
    'search goal Grep',
    'step browser mcp__claude-in-chrome__browser_batch',
    'step app:ccd_turn mcp__ccd_turn__update_plan',
    'step files Read',
    'fail Exit code 1'
  ]);
  assert.ok(events.every(e => e.session === 's1' && e.source === 'claude-code'));
  assert.equal(events[0].title, 'Plan the quarter');
  assert.equal(events.find(e => e.place === 'shell').text, 'ls -la');
  // plain words for people; the call as made stays for developer mode; chatter about the conversation is quiet
  assert.equal(events.find(e => e.place === 'shell').plain, 'List files');
  assert.equal(events.find(e => e.place === 'browser').plain, 'studio.youtube.com, Opens the upload dialog');
  assert.equal(events.find(e => e.tool === 'mcp__ccd_turn__update_plan').quiet, true);
  assert.equal(events.find(e => e.id === 't8' && e.type === 'step').plain, 'missing.md');
  assert.equal(events.find(e => e.type === 'write').created, true);
  assert.deepEqual(events.find(e => e.type === 'search').hits, [path.join(notes, 'a.md')]);
});

test('a session elsewhere shows from the moment it touches a file in the folders', async () => {
  const notes = await tmp('pathnote-cc-notes-'), logs = await tmp('pathnote-cc-logs-'), home = await tmp('pathnote-cc-home-');
  const log = path.join(logs, 's.jsonl');
  const events = [];
  const cc = new ClaudeCode(new Workspace([notes]), e => events.push(e), { dir: logs });
  await cc.start();
  await fs.writeFile(log, [
    use('s', home, 'a', 'Bash', { command: 'before' }),
    use('s', home, 'b', 'Edit', { file_path: path.join(notes, 'n.md'), old_string: 'a', new_string: 'b' }),
    result('s', home, 'b', {}),
    use('s', home, 'c', 'Bash', { command: 'after' })
  ].join(''));
  await cc.read(log);
  cc.stop();
  assert.deepEqual(events.map(e => e.type + ' ' + (e.text || e.path)), [`edit ${path.join(notes, 'n.md')}`, 'step after']);
});

test('a log that starts with an earlier conversation shows only what happens from now on', async () => {
  const notes = await tmp('pathnote-cc-notes-'), logs = await tmp('pathnote-cc-logs-');
  const events = [];
  const cc = new ClaudeCode(new Workspace([notes]), e => events.push(e), { dir: logs });
  await cc.start();
  cc.stop();
  // a resumed session's new log: the old conversation copied in, then new work; one line split across reads
  const log = path.join(logs, 'resumed.jsonl');
  const old = new Date(Date.now() - 3600e3).toISOString();
  const now = line({ type: 'user', sessionId: 'r', cwd: notes, message: { content: 'new 요청' } });
  await fs.writeFile(log, JSON.stringify({ type: 'user', sessionId: 'r', cwd: notes, timestamp: old, message: { content: 'old request' } }) + '\n'
    + JSON.stringify({ type: 'api-request-blob', sessionId: 'r', message: { content: 'x'.repeat(1000) } }) + '\n' + now.slice(0, 40));
  await cc.read(log);
  await fs.appendFile(log, now.slice(40));
  await cc.read(log);
  assert.deepEqual(events.map(e => e.text), ['new 요청']);
});

test('steps say which sites and services they reach, and which leave a mark outside', async () => {
  const notes = await tmp('pathnote-cc-world-');
  const events = [];
  const cc = new ClaudeCode(new Workspace([notes]), e => events.push(e), { dir: notes });
  const at = new Date().toISOString();
  const rec = r => cc.record({ sessionId: 'w', cwd: notes, timestamp: at, ...r });
  const use = (id, name, input) => rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  await use('a', 'Bash', { command: 'curl -s https://www.googleapis.com/youtube/v3/channels?mine=true http://localhost:4747', description: 'Check which channel the login uses' });
  await use('b', 'Bash', { command: 'python upload.py --all', description: 'Upload 7 videos to the channel' });
  await rec({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'done: https://youtu.be/abc https://youtu.be/def' }] } });
  await use('c', 'Bash', { command: 'git push origin main && npx wrangler pages deploy public', description: 'Ship it' });
  await use('d', 'Bash', { command: 'cat upload.py', description: 'Show upload logs' });
  await use('e', 'mcp__claude-in-chrome__navigate', { url: 'https://studio.youtube.com/channel/x' });
  await use('f', 'mcp__claude-in-chrome__computer', { action: 'left_click', action_summary: 'Publish the video' });
  await use('g', 'mcp__gmail__send_email', { to: 'a@b.c' });
  await use('h', 'mcp__scheduled-tasks__update_scheduled_task', { id: 'x' });
  const by = id => events.find(e => e.id === id && e.type === 'step');
  assert.deepEqual(by('a').hosts, ['googleapis.com']); // the address in the command; localhost is this computer
  assert.equal(by('a').out, undefined);
  assert.equal(by('b').hosts, undefined); // a script: nothing to see in the command…
  assert.deepEqual(events.find(e => e.type === 'reach' && e.id === 'b').hosts, ['youtu.be']); // …but its output names it
  assert.equal(by('b').out, true);
  assert.deepEqual(by('c').hosts.sort(), ['cloudflare.com', 'git']);
  assert.equal(by('c').out, true);
  assert.equal(by('d').out, undefined); // looking at upload logs isn't uploading
  assert.deepEqual(by('e').hosts, ['studio.youtube.com']);
  assert.deepEqual(by('f').hosts, ['studio.youtube.com']); // the page the browser is on
  assert.equal(by('f').out, true);
  assert.equal(by('g').out, true);
  assert.equal(by('h').out, undefined);
  assert.deepEqual(hostsIn('see https://docs.example.org/a, http://127.0.0.1:3000 and https://www.x.com:8443/p'), ['docs.example.org', 'x.com']);
});

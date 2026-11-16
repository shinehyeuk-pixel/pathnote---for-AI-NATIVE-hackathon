// A blueprint of recorded work: built from the whole session log (subagents included), the steps in
// words with their sites, results and pitfalls, as Markdown that saves as a Claude Code skill or Codex prompt.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blueprint, toMarkdown, saveBlueprint, slugOf } from '../src/blueprint.js';
import { ClaudeCode } from '../src/claude-code.js';
import { Workspace } from '../src/workspace.js';
import { Hub } from '../src/hub.js';

let tmp;
before(async () => { tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-bp-'))); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const ev = (t, e) => ({ t, session: 's', source: 'claude-code', ...e });
const events = [
  ev(1, { type: 'prompt', text: 'Upload today\'s video to the hyeuk channel' }),
  ev(2, { type: 'read', path: '/v/DAILY.md' }),
  ev(3, { type: 'step', id: 'a', place: 'shell', plain: 'Open Google login for the hyeuk channel', hosts: ['accounts.google.com'] }),
  ev(4, { type: 'step', id: 'b', place: 'shell', plain: 'Upload a private test video', out: true }),
  ev(5, { type: 'fail', id: 'b', text: 'Wrong channel: hyeuk_data\nmore' }),
  ev(6, { type: 'prompt', text: '잘못된 채널이야. 로그인 다시 할게' }),
  ev(7, { type: 'step', id: 'c', place: 'shell', plain: 'Upload 7 videos', out: true }),
  ev(8, { type: 'reach', id: 'c', hosts: ['youtu.be'] }),
  ev(9, { type: 'step', id: 'd', place: 'browser', plain: 'Check the description', hosts: ['studio.youtube.com'] }),
  ev(10, { type: 'step', id: 'e', place: 'browser', plain: 'Check the description', hosts: ['studio.youtube.com'] }),
  ev(11, { type: 'write', path: '/v/uploads.log', created: true }),
  ev(12, { type: 'step', id: 'q', place: 'claude', plain: 'update plan', quiet: true })
];

test('a blueprint has the goal, steps in words, sites, results and pitfalls', () => {
  const b = blueprint(events, { title: 'YouTube upload' });
  assert.equal(b.title, 'YouTube upload');
  assert.equal(b.goal, 'Upload today\'s video to the hyeuk channel');
  assert.deepEqual(b.prepare, { reads: ['/v/DAILY.md'], logins: ['accounts.google.com', 'Open Google login for the hyeuk channel'] });
  assert.deepEqual(b.steps.map(s => [s.text, s.times, s.out, !!s.failed]), [
    ['Read DAILY.md', 1, false, false], ['Open Google login for the hyeuk channel', 1, false, false],
    ['Upload a private test video', 1, true, true], ['Upload 7 videos', 1, true, false],
    ['Check the description', 2, false, false], ['Created uploads.log', 1, false, false]
  ]);
  assert.deepEqual(b.outside.sites.map(s => [s.host, s.out]), [['studio.youtube.com', false], ['accounts.google.com', false], ['youtu.be', false]]);
  assert.deepEqual(b.results.files, ['/v/uploads.log']);
  assert.deepEqual(b.pitfalls, [
    { step: 'Upload a private test video', error: 'Wrong channel: hyeuk_data', then: 'Upload 7 videos' },
    { step: null, error: '잘못된 채널이야. 로그인 다시 할게', then: null, correction: true }
  ]);
});

test('in Korean the steps are in Korean words too', () => {
  const b = blueprint([
    ev(1, { type: 'prompt', text: '출시 공지 올려줘' }),
    ev(2, { type: 'read', path: '/v/고객 인터뷰.md' }),
    ev(3, { type: 'step', id: 'w', tool: 'WebSearch', place: 'web', plain: '노트 앱 출시 공지' }),
    ev(4, { type: 'step', id: 'f', tool: 'WebFetch', place: 'web', plain: 'www.blogger.com' }),
    ev(5, { type: 'write', path: '/v/출시 공지.md', created: true })
  ], { lang: 'ko' });
  assert.deepEqual(b.steps.map(s => s.text), ['고객 인터뷰.md 읽음', '"노트 앱 출시 공지" 웹 검색', 'www.blogger.com 페이지를 읽음', '출시 공지.md 새로 만듦']);
});

test('as Markdown it is a Claude Code skill another agent can follow, with no middle dots', () => {
  const md = toMarkdown(blueprint(events, { title: 'YouTube upload' }), { lang: 'ko' });
  assert.match(md, /^---\nname: youtube-upload\ndescription: "Upload today's video to the hyeuk channel"\n---\n/);
  assert.match(md, /## 순서\n\n1\. Read DAILY\.md\n/);
  assert.match(md, /4\. Upload 7 videos \*\*\(컴퓨터 바깥에 흔적이 남음: 하기 전에 사용자에게 확인\)\*\*/);
  assert.match(md, /5\. Check the description \(2번\)/);
  assert.match(md, /## 함정\n\n- Upload a private test video: Wrong channel: hyeuk_data\. 그다음: Upload 7 videos\n- 사용자가 바로잡은 것: 잘못된 채널이야/);
  assert.ok(!md.includes('·'));
});

test('saving puts it where Claude Code and Codex look, and never overwrites', async () => {
  const home = path.join(tmp, 'home'), env = {};
  const text = toMarkdown(blueprint(events, { title: 'YouTube upload' }));
  const one = saveBlueprint({ name: 'YouTube upload', target: 'claude', text }, { home, env });
  assert.equal(one.file, path.join(home, '.claude', 'skills', 'youtube-upload', 'SKILL.md'));
  const two = saveBlueprint({ name: 'YouTube upload', target: 'claude', text }, { home, env });
  assert.equal(two.name, 'youtube-upload-2');
  assert.match(await fs.readFile(two.file, 'utf8'), /^---\nname: youtube-upload-2\n/); // the skill's name matches its folder
  assert.equal(saveBlueprint({ name: 'YouTube upload', target: 'codex', text }, { home, env }).file, path.join(home, '.codex', 'prompts', 'youtube-upload.md'));
  assert.equal(saveBlueprint({ name: '영상 올리기', target: 'file', text }, { home, env }).file.startsWith(path.join(home, '.pathnote', 'blueprints', 'blueprint-')), true);
  assert.throws(() => saveBlueprint({ name: 'x', target: '../etc', text }, { home, env }), /Claude Code, Codex/);
  assert.throws(() => saveBlueprint({ name: 'x', target: 'file', text: ' ' }, { home, env }), /empty/);
  assert.equal(slugOf('../../evil name!'), 'evil-name');
});

test('the whole session comes from its logs, older records and subagents included, and the viewer serves it', async () => {
  const notes = path.join(tmp, 'notes'), logs = path.join(tmp, 'logs');
  const id = '0f0f0f0f-1111-2222-3333-444444444444';
  await fs.mkdir(notes); await fs.mkdir(path.join(logs, 'p', id, 'subagents'), { recursive: true });
  const line = (t, r) => JSON.stringify({ sessionId: id, cwd: notes, timestamp: new Date(t).toISOString(), ...r }) + '\n';
  await fs.writeFile(path.join(logs, 'p', `${id}.jsonl`), line(1e12, { type: 'user', message: { content: 'Write the plan' } })
    + line(1e12 + 1000, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'WebSearch', input: { query: 'okr' } }] } })
    + line(1e12 + 1500, { type: 'user', message: { content: 'This session is being continued from a previous conversation that ran out of context.' } }));
  await fs.writeFile(path.join(logs, 'p', id, 'subagents', 'agent-1.jsonl'), line(1e12 + 2000, { isSidechain: true, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u', name: 'WebFetch', input: { url: 'https://okr.example.com/x' } }] } }));
  const cc = new ClaudeCode(new Workspace([notes]), () => {}, { dir: logs });
  const { events: all } = await cc.history(id);
  assert.deepEqual(all.map(e => e.type + ' ' + (e.tool || e.text)), ['prompt Write the plan', 'step WebSearch', 'step WebFetch']); // the carried-on summary is not a request
  await assert.rejects(cc.history('../../x'), /Unknown session/);

  const hub = new Hub(new Workspace([notes]), null, 4794, {
    blueprint: async (session, { lang, from }) => { const { events: e } = await cc.history(session); const b = blueprint(e.filter(x => !from || x.t >= from)); return { blueprint: b, markdown: toMarkdown(b, { lang }), requests: e.filter(x => x.type === 'prompt').map(x => ({ t: x.t, text: x.text })) }; }
  });
  await hub.start();
  try {
    hub.broadcast({ t: 1, type: 'prompt', session: id, source: 'claude-code', text: 'Write the plan' });
    const r = await (await fetch(`http://127.0.0.1:${hub.port}/api/blueprint?lang=en`)).json(); // the latest session by default
    assert.equal(r.session, id);
    assert.deepEqual(r.blueprint.outside.sites.map(s => s.host), ['okr.example.com']);
    assert.equal((await fetch(`http://127.0.0.1:${hub.port}/api/blueprint/save`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  } finally { hub.server.close(); }
});

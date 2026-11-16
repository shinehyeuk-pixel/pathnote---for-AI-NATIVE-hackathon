// Claude Code skills opened as a blueprint's mind map: one Pathnote saved splits back the same, one a
// person wrote splits by its headings and lists, and the viewer lists, opens and saves them in place.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { blueprint, toMarkdown, saveBlueprint } from '../src/blueprint.js';
import { listSkills, readSkill, parseSkill, updateSkill } from '../src/skills.js';
import { Workspace } from '../src/workspace.js';
import { Hub } from '../src/hub.js';

let tmp, home, env;
before(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-skills-')));
  home = path.join(tmp, 'home'); env = {};
});
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

const ev = (t, e) => ({ t, session: 's', source: 'claude-code', ...e });
const events = [
  ev(1, { type: 'prompt', text: 'Upload the launch post' }),
  ev(2, { type: 'read', path: '/v/고객 인터뷰.md' }),
  ev(3, { type: 'step', id: 'a', place: 'shell', plain: 'Upload the post', out: true, hosts: ['googleapis.com'] }),
  ev(4, { type: 'fail', id: 'a', text: '401 Unauthorized' }),
  ev(5, { type: 'step', id: 'b', place: 'shell', plain: 'Upload the post again', out: true }),
  ev(6, { type: 'write', path: '/v/출시 공지.md', created: true })
];

test('a skill Pathnote saved splits back into the same branches, in either language', () => {
  for (const lang of ['ko', 'en']) {
    const made = blueprint(events, { title: 'Launch post', lang });
    const b = parseSkill(toMarkdown(made, { lang }), 'launch-post');
    assert.equal(b.title, 'Launch post');
    assert.equal(b.goal, 'Upload the launch post');
    assert.deepEqual(b.prepare.reads, ['/v/고객 인터뷰.md']);
    assert.deepEqual(b.steps.map(s => [s.text, s.out, !!s.failed]), made.steps.map(s => [s.text, s.out, !!s.failed]));
    assert.deepEqual(b.outside.sites.map(s => [s.host, s.out]), made.outside.sites.map(s => [s.host, s.out]));
    assert.deepEqual(b.results.files, ['/v/출시 공지.md']);
    assert.equal(b.pitfalls.length, 1);
    assert.match(b.pitfalls[0].error, /401 Unauthorized/);
  }
});

test('a skill a person wrote splits by its headings and lists', () => {
  const b = parseSkill(`---
name: weekly-report
description: Write the weekly report from the team's notes
---

# Weekly report

## Prerequisites
- Access to the **team drive**
- Sign in to Notion

## Workflow
1. Read last week's notes in \`~/Notes/Team\`
2. Draft the report
   - keep it to one page
3. Post it to https://notion.so/team

\`\`\`bash
- not a step
\`\`\`

## Output
The report as a Notion page.

## Common mistakes
- Don't paste raw meeting notes
`, 'weekly-report');
  assert.equal(b.title, 'Weekly report');
  assert.equal(b.goal, "Write the weekly report from the team's notes");
  assert.deepEqual(b.prepare, { reads: ['Access to the team drive'], logins: ['Sign in to Notion'] });
  assert.deepEqual(b.steps.map(s => s.text), ["Read last week's notes in ~/Notes/Team", 'Draft the report', 'keep it to one page', 'Post it to https://notion.so/team']);
  assert.deepEqual(b.outside.sites.map(s => s.host), ['notion.so']);
  assert.deepEqual(b.results.files, ['The report as a Notion page.']);
  assert.deepEqual(b.pitfalls.map(p => p.error), ["Don't paste raw meeting notes"]);
  // headings the words can't place become the steps
  assert.deepEqual(parseSkill('# X\n\n## Gather\ntext\n\n## Write\ntext\n').steps.map(s => s.text), ['Gather', 'Write']);
});

test('each written step says where it goes, so the map can draw it as a path', () => {
  const b = parseSkill(`# Blog post

## 순서
1. \`노트/리서치/고객 인터뷰.md\` 읽기
2. 가입 지표 노트 읽기
3. https://www.blogger.com 에서 다른 공지 참고
4. \`노트/제품/출시 공지.md\` 쓰기
5. 블로그에 출시 공지 올리기
6. 터미널에서 npm run build 실행
7. 요점 정리하기
`);
  assert.deepEqual(b.steps.map(s => [s.place, s.path || (s.hosts || []).join(), !!s.write, !!s.out]), [
    ['files', '노트/리서치/고객 인터뷰.md', false, false], ['files', '노트', false, false],
    ['web', 'blogger.com', false, false], ['files', '노트/제품/출시 공지.md', true, false],
    ['web', 'blogger.com', false, true], ['shell', '', false, false], ['claude', '', false, false]
  ]);
  // Pathnote's own wording of a file step is read back as that file
  assert.equal(parseSkill('## Steps\n1. Read 고객 인터뷰.md\n2. 출시 공지.md 새로 만듦\n').steps.map(s => s.path).join(), '고객 인터뷰.md,출시 공지.md');
});

test('a recorded step keeps the file it touched and the sites it reached', () => {
  const b = blueprint(events);
  assert.deepEqual(b.steps.map(s => [s.path || '', (s.hosts || []).join(), !!s.write]), [
    ['/v/고객 인터뷰.md', '', false], ['', 'googleapis.com', false], ['', '', false], ['/v/출시 공지.md', '', true]
  ]);
});

test('the viewer lists skills, opens one as a mind map, and saves an edit over it with a backup', async () => {
  const text = toMarkdown(blueprint(events, { title: 'Launch post' }));
  saveBlueprint({ name: 'Launch post', target: 'claude', text }, { home, env });
  await fs.mkdir(path.join(home, '.claude', 'skills', 'empty-folder'), { recursive: true });
  assert.deepEqual(listSkills({ home, env }).map(s => s.name), ['launch-post']);
  assert.equal(readSkill('launch-post', { home, env }).blueprint.title, 'Launch post');
  assert.throws(() => readSkill('../../etc', { home, env }), /no skill named/);

  const hub = new Hub(new Workspace([tmp]), null, 4795, { skills: { home, env } });
  await hub.start();
  const url = p => `http://127.0.0.1:${hub.port}${p}`, post = (p, b, origin = `http://127.0.0.1:${hub.port}`) => fetch(url(p), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(b) });
  try {
    assert.deepEqual((await (await fetch(url('/api/skills'))).json()).skills.map(s => s.name), ['launch-post']);
    const one = await (await fetch(url('/api/skill?name=launch-post'))).json();
    assert.equal(one.blueprint.goal, 'Upload the launch post');
    assert.equal((await fetch(url('/api/skill?name=nope'))).status, 404);
    const parsed = await (await post('/api/skill/parse', { text: '# New\n\n## Steps\n- One\n- Two\n' })).json();
    assert.deepEqual(parsed.blueprint.steps.map(s => s.text), ['One', 'Two']);
    assert.equal((await post('/api/skill/update', { name: 'launch-post', text: 'x' }, 'https://evil.example')).status, 403);
    const saved = await (await post('/api/skill/update', { name: 'launch-post', text: one.text.replace('Upload the launch post', 'Upload the launch post today') })).json();
    assert.match(await fs.readFile(saved.file, 'utf8'), /launch post today/);
    assert.equal(await fs.readFile(saved.backup, 'utf8'), one.text);
  } finally { hub.server.close(); }
  assert.ok(updateSkill);
});

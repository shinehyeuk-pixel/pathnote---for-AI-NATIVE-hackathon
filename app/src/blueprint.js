// A blueprint of one piece of AI work, taken from what it really did: the goal, what it needed first,
// the steps in plain words, the sites and services it reached, what it produced, and the pitfalls it hit
// (failed steps and the user's corrections). Shown as a mind map in the viewer and saved as Markdown that
// another agent can follow: a Claude Code skill, a Codex prompt, or a plain file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_STEPS = 40;
const clip = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const LOGIN = /^(accounts|login|auth|signin|oauth)\./;
const CORRECTION = /잘못|아니|틀렸|다시|말고|wrong|not (that|this|what)|instead|undo|revert/i;

// What a step did, in words, the way the viewer words it in that language
const SAID = {
  en: { read: f => `Read ${f}`, created: f => `Created ${f}`, wrote: f => `Wrote ${f}`, edited: f => `Edited ${f}`, moved: (a, b) => `Moved ${a} to ${b}`, list: f => `Looked in ${f}`, search: q => `Searched the files for "${q}"`, web: q => `Searched the web for "${q}"`, page: h => `Read a page on ${h}`, more: n => `…and ${n} more steps` },
  ko: { read: f => `${f} 읽음`, created: f => `${f} 새로 만듦`, wrote: f => `${f} 작성`, edited: f => `${f} 수정`, moved: (a, b) => `${a}을(를) ${b}(으)로 옮김`, list: f => `${f} 폴더 살펴봄`, search: q => `파일에서 "${q}" 찾음`, web: q => `"${q}" 웹 검색`, page: h => `${h} 페이지를 읽음`, more: n => `외 ${n}단계` }
};
function said(e, w) {
  const f = e.path && path.basename(e.path);
  if (e.type === 'read') return w.read(f);
  if (e.type === 'write') return e.created ? w.created(f) : w.wrote(f);
  if (e.type === 'edit') return w.edited(f);
  if (e.type === 'move') return w.moved(path.basename(e.from || ''), f);
  if (e.type === 'list') return w.list(f);
  if (e.type === 'search') return w.search(e.query);
  if (e.tool === 'WebSearch') return w.web(e.plain || e.text);
  if (e.tool === 'WebFetch') return w.page(e.plain || e.text);
  return clip(e.plain || e.text || e.tool, 140);
}

export function blueprint(events, { title, lang = 'en' } = {}) {
  const w = SAID[lang] || SAID.en;
  const ev = events.filter(e => e && !e.quiet).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
  const prompts = ev.filter(e => e.type === 'prompt').map(e => clip(e.text, 300));
  const failed = new Map(ev.filter(e => e.type === 'fail').map(e => [e.id, clip(String(e.text).split('\n')[0], 200)]));
  const steps = [], reads = [], writes = [], sites = new Map(), apps = new Map(), logins = new Set(), pitfalls = [];
  const wrote = new Set();
  // the sites a step reached, from its call and from what came back
  const reached = new Map();
  for (const e of ev) if (e.type === 'reach' && e.id) reached.set(e.id, [...(reached.get(e.id) || []), ...e.hosts]);
  for (const e of ev) {
    if (e.type === 'reach') { for (const h of e.hosts) { const s = sites.get(h) || { host: h, steps: 0, out: false }; s.steps++; sites.set(h, s); } continue; }
    if (!['step', 'read', 'write', 'edit', 'move', 'list', 'search'].includes(e.type)) continue;
    const text = said(e, w), last = steps[steps.length - 1];
    if (last && last.text === text && !failed.has(e.id)) last.times++;
    else {
      // where it went, so the map can draw the steps as a path: a file, or a place and the sites it reached
      const file = e.type !== 'step', hosts = [...new Set([...(e.hosts || []), ...(reached.get(e.id) || [])])];
      steps.push({ text, place: e.place || 'files', out: !!e.out, failed: failed.get(e.id) || null, times: 1, ...(file && e.path ? { path: e.path, write: ['write', 'edit', 'move'].includes(e.type) } : {}), ...(hosts.length ? { hosts } : {}) });
    }
    if (e.type === 'read' && !wrote.has(e.path) && !reads.includes(e.path)) reads.push(e.path);
    if (['write', 'edit', 'move'].includes(e.type)) { wrote.add(e.path); if (!writes.includes(e.path)) writes.push(e.path); }
    for (const h of e.hosts || []) {
      const s = sites.get(h) || { host: h, steps: 0, out: false };
      s.steps++; s.out ||= !!e.out; sites.set(h, s);
      if (LOGIN.test(h)) logins.add(h);
    }
    if (/^app:/.test(e.place || '')) { const a = e.place.slice(4); apps.set(a, (apps.get(a) || new Set()).add(e.text)); }
    if (/\b(log ?in|sign ?in)\b|로그인/i.test(e.plain || '')) logins.add(clip(e.plain, 80));
  }
  // a failed step, and what came after it at the same place: how it got past
  steps.forEach((s, i) => {
    if (!s.failed) return;
    const next = steps.slice(i + 1).find(x => x.place === s.place && !x.failed);
    pitfalls.push({ step: s.text, error: s.failed, then: next?.text || null });
  });
  // later requests that correct the AI are pitfalls too
  for (const p of prompts.slice(1)) if (CORRECTION.test(p)) pitfalls.push({ step: null, error: p, then: null, correction: true });
  const kept = steps.length > MAX_STEPS ? [...steps.slice(0, MAX_STEPS - 1), { text: w.more(steps.length - MAX_STEPS + 1), place: 'more', times: 1 }] : steps;
  return {
    title: clip(title || prompts[0] || 'AI task', 80),
    goal: prompts[0] || '',
    requests: prompts.slice(1),
    prepare: { reads: reads.slice(0, 15), logins: [...logins] },
    steps: kept,
    outside: { sites: [...sites.values()].sort((a, b) => b.steps - a.steps), apps: [...apps].map(([name, tools]) => ({ name, tools: [...tools].slice(0, 8) })) },
    results: { files: writes.slice(0, 20) },
    pitfalls: pitfalls.slice(0, 15),
    from: ev.length ? { start: ev[0].t, end: ev[ev.length - 1].t } : null
  };
}

const T = {
  en: { goal: 'Goal', prepare: 'Before you start', reads: 'Files it read', logins: 'Sign-ins it needed', steps: 'Steps', out: 'leaves a mark outside this computer: ask the user before doing it', failedAt: 'failed', outside: 'Sites and services', apps: 'Other apps', results: 'Results', pitfalls: 'Pitfalls', then: 'Then', corr: 'The user corrected', times: n => ` (${n} times)`, note: 'Recorded by Pathnote from a real run. Follow the steps, adapt them to today, and stop at every step marked to ask.', none: 'None' },
  ko: { goal: '목표', prepare: '시작 전에 필요한 것', reads: '읽은 파일', logins: '필요했던 로그인', steps: '순서', out: '컴퓨터 바깥에 흔적이 남음: 하기 전에 사용자에게 확인', failedAt: '실패', outside: '접속한 사이트와 서비스', apps: '다른 앱', results: '결과물', pitfalls: '함정', then: '그다음', corr: '사용자가 바로잡은 것', times: n => ` (${n}번)`, note: 'Pathnote가 실제 작업 기록으로 만든 설계도입니다. 순서를 따라 하되 오늘 상황에 맞게 바꾸고, 확인 표시가 있는 단계에서는 꼭 멈춰서 물어보세요.', none: '없음' }
};

// Markdown another agent can follow. The front matter makes it a Claude Code skill as it is.
export function toMarkdown(bp, { lang = 'en', name } = {}) {
  const t = T[lang] || T.en, list = xs => xs.length ? xs.map(x => `- ${x}`).join('\n') : `- ${t.none}`;
  const slug = name || slugOf(bp.title);
  const lines = [
    '---', `name: ${slug}`, `description: ${JSON.stringify(clip(`${bp.goal || bp.title}`, 200))}`, '---', '',
    `# ${bp.title}`, '', `> ${t.note}`, '',
    `## ${t.goal}`, '', bp.goal || bp.title, ...(bp.requests.length ? ['', ...bp.requests.map(r => `- ${r}`)] : []), '',
    `## ${t.prepare}`, '', `${t.reads}:`, list(bp.prepare.reads.map(f => `\`${f}\``)), '', `${t.logins}:`, list(bp.prepare.logins), '',
    `## ${t.steps}`, '', ...bp.steps.map((s, i) => `${i + 1}. ${s.text}${s.times > 1 ? t.times(s.times) : ''}${s.out ? ` **(${t.out})**` : ''}${s.failed ? ` _(${t.failedAt}: ${s.failed})_` : ''}`), '',
    `## ${t.outside}`, '', list(bp.outside.sites.map(s => `${s.host}${s.out ? ` **(${t.out})**` : ''}`)),
    ...(bp.outside.apps.length ? ['', `${t.apps}:`, list(bp.outside.apps.map(a => `${a.name}: ${a.tools.join(', ')}`))] : []), '',
    `## ${t.results}`, '', list(bp.results.files.map(f => `\`${f}\``)), '',
    `## ${t.pitfalls}`, '', list(bp.pitfalls.map(p => p.correction ? `${t.corr}: ${p.error}` : `${p.step}: ${p.error}${p.then ? `. ${t.then}: ${p.then}` : ''}`)), ''
  ];
  return lines.join('\n');
}

// A file name and skill name: lowercase letters, digits and hyphens (Claude Code skills need that)
export function slugOf(s) {
  const slug = String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  if (slug.length >= 3) return slug;
  const d = new Date();
  return `blueprint-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
}

// Where a blueprint goes so the next agent finds it. Never overwrites: a taken name gets -2, -3…
export function saveBlueprint({ name, target, text }, { home = os.homedir(), env = process.env } = {}) {
  const base = slugOf(name);
  const place = {
    claude: n => path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills', n, 'SKILL.md'),
    codex: n => path.join(env.CODEX_HOME || path.join(home, '.codex'), 'prompts', `${n}.md`),
    file: n => path.join(home, '.pathnote', 'blueprints', `${n}.md`)
  }[target];
  if (!place) throw new Error('Save it for Claude Code, Codex or as a file.');
  if (!String(text || '').trim()) throw new Error('The blueprint is empty.');
  let n = base, i = 1;
  while (fs.existsSync(place(n)) || (target === 'claude' && fs.existsSync(path.dirname(place(n))))) n = `${base}-${++i}`;
  const file = place(n);
  // the skill's name has to match its folder
  const body = target === 'claude' ? String(text).replace(/^(---\n(?:.*\n)*?name: ).*$/m, `$1${n}`) : String(text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body.endsWith('\n') ? body : body + '\n');
  return { file, name: n };
}

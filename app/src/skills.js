// Claude Code skills (skills/<name>/SKILL.md) opened as the same mind map a blueprint makes: goal, what
// it needs first, steps, sites and services, results and pitfalls. A skill Pathnote saved splits back
// exactly; one a person wrote is split by its headings and lists as well as they allow.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostsIn } from './claude-code.js';

export const skillsDir = ({ home = os.homedir(), env = process.env } = {}) => path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'skills');

const clip = (s, n = 160) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// The front matter's simple key: value lines
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } } else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    meta[kv[1]] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

// The skills in the skills folder, by name
export function listSkills(opts) {
  const dir = skillsDir(opts);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() || d.isSymbolicLink()).map(d => d.name); } catch { return []; }
  const out = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    const file = path.join(dir, name, 'SKILL.md');
    try {
      const { meta } = frontMatter(fs.readFileSync(file, 'utf8').slice(0, 4000));
      out.push({ name, description: clip(meta.description || '', 200), file });
    } catch {}
  }
  return out;
}

// Only a skill that is listed: a name never becomes a path of its own
function find(name, opts) {
  const s = listSkills(opts).find(x => x.name === name);
  if (!s) throw new Error(`There is no skill named "${name}".`);
  return s;
}

export function readSkill(name, opts) {
  const s = find(name, opts);
  const text = fs.readFileSync(s.file, 'utf8');
  return { name: s.name, file: s.file, text, blueprint: parseSkill(text, s.name) };
}

// Saves an edited skill over the old one, keeping the old one in ~/.pathnote/skill-backups
export function updateSkill({ name, text }, opts = {}) {
  if (!String(text || '').trim()) throw new Error('The skill is empty.');
  const s = find(name, opts);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(opts.home || os.homedir(), '.pathnote', 'skill-backups', `${s.name}-${stamp}.md`);
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(s.file, backup);
  fs.writeFileSync(s.file, String(text).endsWith('\n') ? String(text) : text + '\n');
  return { file: s.file, name: s.name, backup };
}

// Which branch a heading's words belong to. Pathnote's own headings (ko and en) are among them.
const KINDS = [
  ['pitfalls', /pitfall|gotcha|warning|caution|caveat|avoid|don'?t|never|mistake|troubleshoot|함정|주의|금지|하지 ?말|실수|문제/i],
  ['prepare', /before|prereq|require|set ?up|install|need|input|준비|필요|시작 전|설치|입력/i],
  ['outside', /site|service|\bapis?\b|external|integration|\btools?\b|\bmcp\b|사이트|서비스|외부|바깥|연동|도구/i],
  ['results', /result|output|deliverable|produce|결과|산출|출력/i],
  ['steps', /step|workflow|process|procedure|instruction|how to|usage|guide|순서|단계|절차|방법|사용법|진행/i],
  ['goal', /goal|purpose|overview|about|when to use|목표|목적|개요|언제/i]
];
const kindOf = h => KINDS.find(([, re]) => re.test(h))?.[0] || null;

// Markdown marks off, the words kept
const plain = s => String(s).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').replace(/^\s*\[[ xX]\]\s+/, '').trim();

const OUT = /\s*\*\*\((?:컴퓨터 바깥에 흔적이 남음|leaves a mark outside)[^)]*\)\*\*/i;
const FAILED = /\s*_\((?:실패|failed): ([^)]*)\)_/i;
const TIMES = /\s*\((\d+)(?:번| times)\)$/;
const HOST = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const PATHLIKE = /^(?:~|\/|[A-Za-z]:\\)/;

// Where a written step goes, from its words: a file, the terminal, the web, the browser, or the AI itself.
// A step that puts something outside with no site named goes to the site the skill names.
const FILE = /(?:^|[\s"'(`])((?:[~.\/\\]|[A-Za-z]:\\)?[^\s"'(),`]*?[^\s"'(),`/\\]+\.(?:md|txt|json|csv|tsv|ya?ml|toml|js|ts|py|html|css|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|mp4|mov|sh|log))(?=$|[\s"'),.`:])/i;
const BARE_HOST = /\b((?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|so|co|kr|app|ai|me|tv|page|site))\b/i;
const WRITES = /쓰기|쓴다|씁니다|작성|만들|새로|저장|고치|고쳐|수정|정리|\b(?:write|wrote|writ|creat|save|draft|edit|update|append)/i;
const OUTWARD = /올리|게시|배포|업로드|보내|전송|공유|\b(?:publish|post|upload|deploy|send|share|push)/i;
const SHELL = /터미널|명령|실행|\b(?:terminal|command|run|ran|npm|npx|git|gh|curl|python|node|bash|script)\b/i;
const BROWSER = /브라우저|크롬|클릭|\b(?:browser|chrome|click|navigate)/i;
const WEB = /웹|검색|페이지|참고|사이트|\b(?:web|search|page|site|fetch|look up)/i;
const FILES = /(노트|문서|파일|폴더|메모)|\b(notes?|files?|folders?|docs?|documents?)\b/i;
// Pathnote's own wording of a file step (blueprint.js): the file is all that's left
const SAID_FILE = [/^(?:Read|Created|Wrote|Edited) (.+)$/, /^(.+) (?:읽음|새로 만듦|작성|수정)$/];
const hasExt = f => /\.[A-Za-z0-9]{1,5}$/.test(f || '');
function where({ code, ...step }, sites) {
  const t = step.text, url = hostsIn(t);
  const said = SAID_FILE.map(re => re.exec(t)?.[1]).find(hasExt);
  const file = hasExt(code) ? code : said || FILE.exec(t)?.[1];
  if (file && !url.length) return { ...step, place: 'files', path: file.replace(/[\\/]+$/, ''), write: WRITES.test(t) };
  const hosts = url.length ? url : BARE_HOST.test(t) ? [BARE_HOST.exec(t)[1].toLowerCase().replace(/^www\./, '')] : [];
  const out = step.out || OUTWARD.test(t) && (hosts.length > 0 || sites.length > 0);
  if (!hosts.length && out && sites.length) hosts.push(sites[0]);
  const place = SHELL.test(t) ? 'shell' : BROWSER.test(t) ? 'browser' : hosts.length || WEB.test(t) ? 'web' : FILES.test(t) ? 'files' : 'claude';
  if (place === 'files') { const m = FILES.exec(t); return { ...step, place, path: m[1] || m[2], write: WRITES.test(t) }; }
  return { ...step, place, out, ...(hosts.length ? { hosts } : {}) };
}

export function parseSkill(text, name = '') {
  const { meta, body } = frontMatter(String(text || ''));
  // sections: the heading, its level, and the lines under it, code blocks left out
  const sections = [];
  let cur = { level: 0, head: '', lines: [] }, fence = false, title = '';
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      if (h[1].length === 1 && !title) { title = plain(h[2]); continue; }
      sections.push(cur); cur = { level: h[1].length, head: plain(h[2]), lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  sections.push(cur);
  // list items, or failing that the first sentence of each paragraph
  const listItems = lines => lines.map(l => /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l)?.[1]).filter(Boolean).map(s => s.trim()).filter(s => !/^(none|없음)$/i.test(s));
  const itemsOf = lines => {
    const items = listItems(lines);
    if (items.length) return items;
    return lines.join('\n').split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).filter(p => p && !/^[>|]/.test(p) && !/:$/.test(p)).map(p => (/^(.+?[.!?。])(\s|$)/.exec(p)?.[1] || p));
  };
  const firstPara = lines => lines.join('\n').split(/\n\s*\n/).map(p => p.replace(/\s+/g, ' ').trim()).find(p => p && !/^(?:[-*+>]|\d+[.)])\s/.test(p)) || '';

  const bp = { title: '', goal: '', requests: [], prepare: { reads: [], logins: [] }, steps: [], outside: { sites: [], apps: [] }, results: { files: [] }, pitfalls: [], from: null, skill: name };
  const sites = new Map(), loose = [];
  const site = (h, out = false) => { h = h.replace(/^www\./, ''); const s = sites.get(h) || { host: h, steps: 0, out: false }; s.out ||= out; sites.set(h, s); };
  let kind = null, kindLevel = 0;
  for (const s of sections) {
    const k = s.head ? kindOf(s.head) : null;
    // a heading the words don't place inherits the branch of the heading it sits under
    if (k) { kind = k; kindLevel = s.level; } else if (!s.head || s.level <= kindLevel) { kind = null; kindLevel = 0; }
    if (!s.head) continue;
    const items = itemsOf(s.lines);
    if (kind === 'goal') {
      bp.goal ||= clip(plain(firstPara(s.lines)), 300);
      bp.requests.push(...listItems(s.lines).map(i => clip(plain(i), 300)));
    } else if (kind === 'prepare') {
      for (const i of items) { const t = plain(i); if (/^(?:accounts|login|auth|signin|oauth)\./i.test(t) || /log ?in|sign ?in|로그인/i.test(t)) bp.prepare.logins.push(clip(t, 120)); else bp.prepare.reads.push(clip(t, 160)); }
    } else if (kind === 'steps') {
      for (const i of items) {
        let t = i; const out = OUT.test(t); t = t.replace(OUT, '');
        const failed = FAILED.exec(t)?.[1] || null; t = t.replace(FAILED, '');
        const times = Number(TIMES.exec(t)?.[1]) || 1; t = t.replace(TIMES, '');
        const code = /`([^`]+)`/.exec(t)?.[1];
        bp.steps.push({ text: clip(plain(t), 160), place: 'skill', out, failed, times, ...(code ? { code } : {}) });
      }
    } else if (kind === 'outside') {
      for (const i of items) {
        let t = i; const out = OUT.test(t); t = plain(t.replace(OUT, ''));
        if (HOST.test(t)) site(t, out);
        else { const app = clip(t.split(':')[0], 60); if (app && !bp.outside.apps.some(a => a.name === app)) bp.outside.apps.push({ name: app, tools: [] }); }
      }
    } else if (kind === 'results') {
      bp.results.files.push(...items.map(i => clip(plain(i), 160)));
    } else if (kind === 'pitfalls') {
      bp.pitfalls.push(...items.map(i => ({ step: null, error: clip(plain(i), 200), then: null })));
    } else loose.push({ head: s.head, items });
  }
  // a skill with no step heading: the headings it does have, in order, are its steps
  if (!bp.steps.length) for (const l of loose) bp.steps.push({ text: clip(l.head, 160), place: 'skill', out: false, failed: null, times: 1 });
  if (!bp.steps.length) bp.steps = itemsOf(sections.flatMap(s => s.lines)).slice(0, 40).map(i => ({ text: clip(plain(i), 160), place: 'skill', out: false, failed: null, times: 1 }));
  for (const h of hostsIn(body)) if (!h.includes('example')) site(h);
  bp.outside.sites = [...sites.values()];
  bp.goal ||= clip(meta.description || firstPara(sections[0].lines), 300);
  bp.title = clip(title || meta.name || name || 'Skill', 80);
  bp.steps = bp.steps.slice(0, 60).map(st => where(st, bp.outside.sites.map(x => x.host)));
  for (const st of bp.steps) for (const h of st.hosts || []) if (!sites.has(h)) { site(h, st.out); bp.outside.sites = [...sites.values()]; }
  return bp;
}

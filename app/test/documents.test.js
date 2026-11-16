// Documents and pictures: text comes out of PDF and Office/Hangul files, pictures come back as images.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { Workspace } from '../src/workspace.js';

let dir, ws;

// A one-page PDF that says `text`, with a correct cross-reference table
function pdf(text) {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  const stream = `BT /F1 12 Tf 20 50 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const zip = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

after(() => fs.rm(dir, { recursive: true, force: true }));
before(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-docs-')));
  await fs.writeFile(path.join(dir, 'report.pdf'), pdf('Quarterly onboarding report'));
  await fs.writeFile(path.join(dir, 'essay.docx'), zip({
    'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Catalysts speed up</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">reactions &amp; save energy.</w:t></w:r></w:p></w:body></w:document>'
  }));
  await fs.writeFile(path.join(dir, 'deck.pptx'), zip({
    'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></p:sld>',
    'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Title slide</a:t></a:r></a:p></p:sld>'
  }));
  await fs.writeFile(path.join(dir, 'grades.xlsx'), zip({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Scores" sheetId="1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Kim</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Score</t></is></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>95</v></c></row></sheetData></worksheet>'
  }));
  await fs.writeFile(path.join(dir, '보고서.hwpx'), zip({
    'Contents/section0.xml': '<hs:sec><hp:p><hp:run><hp:t>한글 문서 내용</hp:t></hp:run></hp:p></hs:sec>'
  }));
  await fs.writeFile(path.join(dir, 'dot.png'), PNG);
  ws = new Workspace([dir]);
});

test('PDF text', async () => {
  const f = await ws.open(path.join(dir, 'report.pdf'));
  assert.equal(f.kind, 'document');
  assert.match(f.text, /--- page 1 ---\nQuarterly onboarding report/);
});

test('Word, PowerPoint, Excel and Hangul text', async () => {
  assert.equal((await ws.open(path.join(dir, 'essay.docx'))).text, 'Catalysts speed up\nreactions & save energy.');
  assert.equal((await ws.open(path.join(dir, 'deck.pptx'))).text, '--- slide 1 ---\nTitle slide\n\n--- slide 2 ---\nSecond slide');
  assert.equal((await ws.open(path.join(dir, 'grades.xlsx'))).text, '--- sheet: Scores ---\nName\tScore\nKim\t95');
  assert.equal((await ws.open(path.join(dir, '보고서.hwpx'))).text, '한글 문서 내용');
});

test('pictures come back as images', async () => {
  const f = await ws.open(path.join(dir, 'dot.png'));
  assert.equal(f.kind, 'image');
  assert.equal(f.mimeType, 'image/png');
  assert.equal(Buffer.from(f.data, 'base64').length, PNG.length);
});

test('search finds words inside documents', async () => {
  const hits = await ws.search('catalysts');
  assert.equal(hits[0].path, path.join(dir, 'essay.docx'));
  assert.equal((await ws.search('onboarding'))[0].path, path.join(dir, 'report.pdf'));
});

// search keeps file text in memory; a changed file must be read again
test('search sees a text file change after it was cached', async () => {
  const note = path.join(dir, 'cached.md');
  await ws.write(note, 'alpha words');
  assert.equal((await ws.search('alpha'))[0]?.path, note);
  await ws.write(note, 'beta words, longer now');
  assert.equal((await ws.search('alpha')).length, 0);
  assert.equal((await ws.search('beta'))[0]?.path, note);
  await ws.remove(note);
});

// warm(), graph() and search() run together at startup and may read the same file at once
test('the text cache counts each file once when reads overlap', async () => {
  const notes = await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-cache-'));
  for (let i = 0; i < 40; i++) await fs.writeFile(path.join(notes, `n${i}.md`), `note ${i} [[n${(i + 1) % 40}]] ` + 'x'.repeat(i * 50));
  const w = new Workspace([notes]);
  await Promise.all([w.warm(), w.graph(), w.search('note'), w.search('x')]);
  const sum = [...w.texts.values()].reduce((n, e) => n + e.size, 0);
  assert.equal(w.texts.size, 40);
  assert.equal(w.cached, sum);
  assert.equal((await w.graph()).links.length, 40);
  await fs.rm(notes, { recursive: true, force: true });
});

test('documents and pictures are never written', async () => {
  await assert.rejects(ws.write(path.join(dir, 'essay.docx'), 'x'), /not write/);
  await assert.rejects(ws.write(path.join(dir, 'dot.png'), 'x'), /not write/);
});

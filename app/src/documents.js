// Reads files that aren't plain text: text out of PDF, Word, PowerPoint, Excel and Hangul (.hwpx)
// files, and pictures as images the AI can look at. Read-only: Pathnote never writes these.
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { unzipSync, strFromU8 } from 'fflate';
import { getDocumentProxy, extractText } from 'unpdf';

const run = promisify(execFile);
const DOCS = new Set(['.pdf', '.docx', '.pptx', '.xlsx', '.hwpx']);
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
export const MAX_DOC = 50 * 1024 * 1024;
const MAX_TEXT = 200_000;
// Claude accepts images up to about 5 MB once base64-encoded
const MAX_IMAGE = 3.5 * 1024 * 1024;

export const isDocument = p => DOCS.has(path.extname(p).toLowerCase());
export const isImage = p => path.extname(p).toLowerCase() in IMAGES;

const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// XML -> text, with a line break wherever the format ends a paragraph
const xmlText = (xml, paragraph) => decode(xml
  .replace(new RegExp(`</${paragraph}>`, 'g'), '\n')
  .replace(/<(w:tab|a:tab|hp:tab)\b[^>]*\/>/g, '\t')
  .replace(/<[^>]+>/g, ''))
  .replace(/\n{3,}/g, '\n\n').trim();

// "ppt/slides/slide10.xml" sorts after "slide9.xml"
const byNumber = (a, b) => (+a.match(/(\d+)\.xml$/)?.[1] || 0) - (+b.match(/(\d+)\.xml$/)?.[1] || 0);

// An entry this large unpacked is a zip bomb or not a real document: refuse it instead of filling memory
const MAX_ENTRY = 64 * 1024 * 1024;
function unzip(buf, keep) {
  const files = unzipSync(new Uint8Array(buf), { filter: f => {
    if (!keep(f.name)) return false;
    if (f.originalSize > MAX_ENTRY) throw new Error('This document unpacks to more than 64 MB, so Pathnote won\'t open it.');
    return true;
  } });
  return Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strFromU8(v)]));
}

function xlsx(buf) {
  const z = unzip(buf, n => n === 'xl/sharedStrings.xml' || n === 'xl/workbook.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
  const shared = [...(z['xl/sharedStrings.xml'] || '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => decode(m[1].replace(/<[^>]+>/g, '')));
  const names = [...(z['xl/workbook.xml'] || '').matchAll(/<sheet [^>]*name="([^"]*)"/g)].map(m => decode(m[1]));
  return Object.keys(z).filter(k => k.startsWith('xl/worksheets/')).sort(byNumber).map((k, i) => {
    const rows = [...z[k].matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(r =>
      [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, body = '']) => {
        const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (/t="s"/.test(attrs)) return shared[+v] ?? '';
        if (/t="inlineStr"/.test(attrs)) return decode(body.replace(/<[^>]+>/g, ''));
        return v === undefined ? '' : decode(v);
      }).join('\t'));
    return `--- sheet: ${names[i] ?? i + 1} ---\n${rows.join('\n')}`;
  }).join('\n\n');
}

// Text of a document. `buf` is the file's bytes.
export async function documentText(file, buf) {
  const ext = path.extname(file).toLowerCase();
  let text;
  if (ext === '.pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text: pages } = await extractText(pdf, { mergePages: false });
    text = pages.map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`).join('\n\n');
  } else if (ext === '.docx') {
    text = xmlText(unzip(buf, n => n === 'word/document.xml')['word/document.xml'] || '', 'w:p');
  } else if (ext === '.pptx') {
    const z = unzip(buf, n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
    text = Object.keys(z).sort(byNumber).map((k, i) => `--- slide ${i + 1} ---\n${xmlText(z[k], 'a:p')}`).join('\n\n');
  } else if (ext === '.xlsx') {
    text = xlsx(buf);
  } else if (ext === '.hwpx') {
    const z = unzip(buf, n => /^Contents\/section\d+\.xml$/.test(n));
    text = Object.keys(z).sort(byNumber).map(k => xmlText(z[k], 'hp:p')).join('\n\n');
  } else {
    throw new Error(`Pathnote can't read ${ext} files.`);
  }
  if (!text.trim()) return '(No text found. It may be a scanned document made of images.)';
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + `\n\n(cut off at ${MAX_TEXT} characters)` : text;
}

// An image the AI can look at. HEIC (iPhone photos) and large pictures go through macOS `sips`
// to become a JPEG small enough to send.
export async function imageContent(file, buf) {
  const ext = path.extname(file).toLowerCase();
  if (ext !== '.heic' && buf.length <= MAX_IMAGE) return { data: buf.toString('base64'), mimeType: IMAGES[ext] };
  // Only macOS has `sips` built in; elsewhere the picture has to be made smaller or converted by hand
  if (process.platform !== 'darwin') throw new Error(ext === '.heic'
    ? `"${file}" is a HEIC picture, which Pathnote can only convert on a Mac. Save it as JPEG or PNG first.`
    : `"${file}" is too large to send as an image (over 3.5 MB). Pathnote can only shrink pictures on a Mac; save a smaller copy first.`);
  const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'pathnote-')), 'image.jpg');
  try {
    await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '1600', file, '--out', out]);
    const small = await fs.readFile(out);
    if (small.length > MAX_IMAGE) throw new Error(`"${file}" is still too large after shrinking.`);
    return { data: small.toString('base64'), mimeType: 'image/jpeg' };
  } finally {
    await fs.rm(path.dirname(out), { recursive: true, force: true });
  }
}

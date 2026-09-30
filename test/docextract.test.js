/* node test/docextract.test.js — DOCUMENT-TO-TEXT for fs.read (.docx / .xlsx / .ipynb).

   fs.read decoded everything as UTF-8, so the three formats a Commander actually keeps work in came back as
   binary noise: the agent could see the file existed and had no way to read it. OOXML is a ZIP of XML and a
   notebook is plain JSON, so all three are readable with what Node already ships — NO new dependency, which
   is a hard constraint (a native zip/office dep cuts against the Tauri-shippable desktop bundle).

   The ZIP fixtures here are BUILT BYTE BY BYTE rather than checked in: a real central directory, real local
   headers, and both storage methods (stored and deflate), so the reader is proven against the actual format
   instead of against a blob someone once generated. */
'use strict';
const A = require('./_assert.js');
const zlib = require('node:zlib');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { makeDocExtract } = require('../sidecar/tools/builtin/docextract.js');
const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');

const doc = makeDocExtract({ inflateRaw: zlib.inflateRawSync });

/* ---- a minimal but REAL zip writer, so the reader is tested against the format, not against itself ---- */
function zip(files, opts) {
  opts = opts || {};
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const deflate = opts.store !== true;
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10); ch.writeUInt32LE(0, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22 + (opts.comment ? opts.comment.length : 0));
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  if (opts.comment) { eocd.writeUInt16LE(opts.comment.length, 20); Buffer.from(opts.comment).copy(eocd, 22); }
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const DOCX = (body) => zip({ '[Content_Types].xml': '<x/>', 'word/document.xml': '<?xml version="1.0"?><w:document><w:body>' + body + '</w:body></w:document>' });

(async () => {
  // ---- 1. DOCX: paragraphs become lines, runs inside a paragraph join, entities decode ----
  {
    const buf = DOCX('<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>' +
                     '<w:p><w:r><w:t>Tom &amp; Jerry &lt;3</w:t></w:r></w:p>' +
                     '<w:p><w:r><w:t>a</w:t></w:r><w:tab/><w:r><w:t>b</w:t></w:r></w:p>');
    A.eq(doc.sniff('report.docx', buf), 'docx', 'a .docx with ZIP magic sniffs as docx');
    const text = doc.extract(buf, 'docx');
    A.eq(text.split('\n')[0], 'Hello world', 'runs inside one paragraph join into one line');
    A.eq(text.split('\n')[1], 'Tom & Jerry <3', 'XML entities decode (and &amp; resolves LAST, not into a tag)');
    A.eq(text.split('\n')[2], 'a\tb', 'a w:tab becomes a real tab');
  }

  // ---- 2. XLSX: shared strings resolve, inline strings work, sheets are NAMED, empty rows vanish ----
  {
    const buf = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Q3 Actuals" sheetId="1"/><sheet name="Notes" sheetId="2"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Region</t></si><si><t>Rev</t></si><si><t>EM</t><t>EA</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>1250.5</v></c></row>' +
        '<row r="3"><c r="A3"/><c r="B3"/></row>' +
        '<row r="4"><c r="A4" t="inlineStr"><is><t>inline!</t></is></c></row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'
    });
    const text = doc.extract(buf, 'xlsx');
    A.ok(/^### Q3 Actuals$/m.test(text), 'the sheet is labelled with its real NAME from workbook.xml');
    A.ok(/^Region\tRev$/m.test(text), 'shared-string cells resolve and a row is tab separated');
    A.ok(/^EMEA\t1250\.5$/m.test(text), 'a multi-run shared string joins, and a numeric cell passes through');
    // The empty <row r="3"> must vanish entirely: the Q3 block holds exactly its three real rows.
    const q3 = text.split('### ')[1].split('\n').slice(1).filter(Boolean);
    A.eq(q3.length, 3, 'a fully empty row is dropped rather than emitted as a line of blank tabs');
    A.ok(/inline!/.test(text), 'an inlineStr cell is read');
    A.ok(/^### Notes$/m.test(text), 'the second sheet is present, under its own name');
  }

  // ---- 3. IPYNB: source AND outputs — the RESULT is usually the answer, not the code ----
  {
    const nb = Buffer.from(JSON.stringify({
      metadata: { kernelspec: { language: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# Title\n', 'some prose'] },
        { cell_type: 'code', source: 'print(2+2)\n', outputs: [{ output_type: 'stream', text: ['4\n'] }] },
        { cell_type: 'code', source: 'df.head()', outputs: [{ output_type: 'execute_result', data: { 'text/plain': '   a\n0  1' } }] },
        { cell_type: 'code', source: 'boom()', outputs: [{ output_type: 'error', ename: 'ValueError', evalue: 'nope' }] },
        { cell_type: 'code', source: 'plot()', outputs: [{ output_type: 'display_data', data: { 'image/png': 'BASE64' } }] }
      ]
    }), 'utf8');
    A.eq(doc.sniff('analysis.ipynb'), 'ipynb', '.ipynb sniffs without needing the bytes');
    const text = doc.extract(nb, 'ipynb');
    A.ok(/# Title\nsome prose/.test(text), 'markdown cells come through as prose');
    A.ok(/```python  # cell 2\nprint\(2\+2\)\n```/.test(text), 'code cells are fenced and numbered');
    A.ok(/\[output\]\n4/.test(text), 'stream output is kept — it is usually the answer');
    A.ok(/\[output\]\n {3}a\n0 {2}1/.test(text), 'a text/plain execute_result is kept');
    A.ok(/\[error\] ValueError: nope/.test(text), 'an error output is surfaced, not silently dropped');
    A.ok(/not text, omitted/.test(text), 'a non-text output is NAMED as omitted rather than pretended away');
  }

  // ---- 4. THE ZIP READER against the real format: stored entries, and a trailing archive comment ----
  {
    const stored = zip({ 'word/document.xml': '<w:p><w:r><w:t>stored</w:t></w:r></w:p>' }, { store: true });
    A.eq(doc.extract(stored, 'docx'), 'stored', 'an UNCOMPRESSED (method 0) entry reads');
    const commented = zip({ 'word/document.xml': '<w:p><w:r><w:t>commented</w:t></w:r></w:p>' }, { comment: 'x'.repeat(300) });
    A.eq(doc.extract(commented, 'docx'), 'commented', 'the EOCD is found past a 300-byte archive comment (not just the last 22 bytes)');
  }

  // ---- 5. HONEST FAILURE. A malformed or mislabelled document must not be reported as empty content. ----
  {
    let threw = false;
    try { doc.extract(Buffer.from('PK\x03\x04 not really a zip'), 'docx'); } catch (_) { threw = true; }
    A.ok(threw, 'a corrupt archive throws instead of returning silence');
    try { doc.extract(zip({ 'other.xml': '<x/>' }), 'docx'); threw = true; } catch (_) { threw = true; }
    A.ok(threw, 'a zip with no word/document.xml is not a Word document');
    try { doc.extract(Buffer.from('{not json'), 'ipynb'); } catch (_) { threw = true; }
    A.ok(threw, 'an unparseable notebook throws');
    A.eq(doc.sniff('notes.docx', Buffer.from('just text, honest')), null,
      'a file merely NAMED .docx that is not a ZIP is not claimed as a document');
  }

  // ---- 6. END TO END through fs.read — including the fall-through that keeps a mislabelled file readable ----
  {
    const ROOT = path.join(os.tmpdir(), 'starnet-docx-test-' + process.pid);
    const { readTool } = makeFsTools({ fsp, pathMod: path, root: ROOT, docExtract: doc, limits: { readReturn: 100000 } });
    const CTX = { agentId: 'ag', emit: () => {} };
    await fsp.mkdir(path.join(ROOT, 'ag'), { recursive: true });
    try {
      await fsp.writeFile(path.join(ROOT, 'ag', 'r.docx'), DOCX('<w:p><w:r><w:t>from disk</w:t></w:r></w:p>'));
      const r = await readTool.run({ path: 'r.docx' }, CTX);
      A.eq(r.content, 'from disk', 'fs.read returns extracted TEXT for a .docx, not binary noise');
      A.ok(/docx/.test(r.summary), 'the summary says the file was extracted');

      // A file someone named .docx that is really text must still be readable — the extractor falls through.
      await fsp.writeFile(path.join(ROOT, 'ag', 'fake.docx'), 'actually plain text', 'utf8');
      const f = await readTool.run({ path: 'fake.docx' }, CTX);
      A.eq(f.content, 'actually plain text', 'a mislabelled document falls through to the plain read');

      // And an ordinary text file is completely untouched by any of this.
      await fsp.writeFile(path.join(ROOT, 'ag', 'plain.txt'), 'hello', 'utf8');
      A.eq((await readTool.run({ path: 'plain.txt' }, CTX)).content, 'hello', 'ordinary text reads exactly as before');

      // Unwired extractor = the historic behavior, byte for byte.
      const bare = makeFsTools({ fsp, pathMod: path, root: ROOT, limits: { readReturn: 100000 } });
      const b = await bare.readTool.run({ path: 'r.docx' }, CTX);
      A.ok(b.content.indexOf('from disk') < 0, 'with no docExtract wired, a .docx still decodes as raw bytes (unchanged)');
    } finally { await fsp.rm(ROOT, { recursive: true, force: true }); }
  }

  // ---- ZIP BOMB (security audit 2026-09-25): inflate output is capped per entry and per document ----
  {
    const seen = [];
    const spy = makeDocExtract({ inflateRaw: (b, o) => { seen.push(o && o.maxOutputLength); return zlib.inflateRawSync(b, o); } });
    spy.extract(zip({ 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>hi</w:t></w:r></w:p></w:body></w:document>' }), 'docx');
    A.ok(seen.length === 1 && seen[0] > 0 && seen[0] <= 32 * 1024 * 1024, 'every inflate is called with a bounded maxOutputLength');
    const huge = '<w:document><w:body><w:p><w:r><w:t>' + 'a'.repeat(33 * 1024 * 1024) + '</w:t></w:r></w:p></w:body></w:document>';
    const bomb = zip({ 'word/document.xml': huge });
    A.ok(bomb.length < 200 * 1024, 'the bomb is small on disk (' + bomb.length + ' bytes)');
    let threw = null;
    try { doc.extract(bomb, 'docx'); } catch (e) { threw = e; }
    A.ok(!!threw, 'a document inflating past the ceiling is refused, not expanded (' + (threw && (threw.code || threw.message)) + ')');
  }

  A.report('docextract.test');
})().catch(e => { console.log('FAIL: docextract.test threw -- ' + (e && e.stack || e)); process.exit(1); });

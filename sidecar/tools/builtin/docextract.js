/* sidecar/tools/builtin/docextract.js — DOCUMENT-TO-TEXT for fs.read.

   fs.read decoded everything as UTF-8, so a .docx / .xlsx / .ipynb came back as binary noise — the agent could
   see that a file existed and had no way to read it. Those three are the formats a Commander actually keeps
   work in, and all three are readable with what Node already ships: OOXML is a ZIP of XML, and a notebook is
   plain JSON. NO NEW DEPENDENCY — that is a hard constraint here (the desktop bundle is Tauri-shippable and a
   native zip/office dep would cut against it), which is why this file carries its own small ZIP reader.

   DELIBERATELY LOSSY AND HONEST ABOUT IT. This extracts the TEXT a reader would see: paragraphs from a
   document, cells from a sheet, source and text output from a notebook. Styling, images, formulas-as-formulas,
   charts and comments are dropped. A caller that needs fidelity should open the file, not read it.

   makeDocExtract({ inflateRaw }) -> { sniff, extract, _internals }
     inflateRaw(buf, { maxOutputLength }) -> Buffer   // zlib.inflateRawSync, injected so this module stays pure + testable
     sniff(nameOrPath, buf?) -> 'docx' | 'xlsx' | 'ipynb' | null
     extract(buf, kind, opts?) -> string        // throws on a malformed container; the caller falls back */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).docextract = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MAX_CHARS = 200000;
  const MAX_SHEET_ROWS = 5000;      // a spreadsheet can be a million rows; the prompt cannot
  const MAX_ROW_CELLS = 256;
  // ZIP-BOMB CEILING. The declared sizes in a ZIP header are attacker-controlled and deflate reaches ~1000:1, so a
  // 1 MB .docx/.xlsx an agent downloaded could inflate to a gigabyte — synchronously, freezing the whole sidecar
  // (UI, API, every run) or exhausting memory. Each entry and the whole document share a hard output budget; past
  // it extract() throws and fs.read falls back to the plain read. Real documents are nowhere near these numbers.
  const MAX_ENTRY_INFLATE = 32 * 1024 * 1024;
  const MAX_TOTAL_INFLATE = 64 * 1024 * 1024;

  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50, LOC_SIG = 0x04034b50;

  function extOf(nameOrPath) {
    const base = String(nameOrPath == null ? '' : nameOrPath).split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  }
  // Extension decides, but a ZIP magic check keeps a mislabelled file from being reported as a broken document
  // when it is really just a text file someone named .docx.
  function sniff(nameOrPath, buf) {
    const ext = extOf(nameOrPath);
    if (ext === 'ipynb') return 'ipynb';
    if (ext !== 'docx' && ext !== 'xlsx') return null;
    if (buf && buf.length >= 2 && !(buf[0] === 0x50 && buf[1] === 0x4b)) return null;   // not a ZIP -> not OOXML
    return ext;
  }

  /* ---- the ZIP reader. Central-directory driven (the only authoritative index in the format); the local
     header is consulted purely to find where each entry's bytes actually start, because its name/extra
     lengths can legally differ from the central copy. ---- */
  function findEocd(buf) {
    // The comment field is up to 64k, so the record is not necessarily the last 22 bytes.
    const from = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= from; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) return i;
    }
    return -1;
  }
  function readEntries(buf) {
    const eocd = findEocd(buf);
    if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    if (p === 0xffffffff) throw new Error('zip64 archives are not supported');
    const out = new Map();
    for (let i = 0; i < count && p + 46 <= buf.length; i++) {
      if (buf.readUInt32LE(p) !== CEN_SIG) break;
      const method = buf.readUInt16LE(p + 10);
      const compSize = buf.readUInt32LE(p + 20);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const cmtLen = buf.readUInt16LE(p + 32);
      const localAt = buf.readUInt32LE(p + 42);
      const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
      out.set(name, { method, compSize, localAt });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }
  function entryBytes(buf, e, inflateRaw) {
    if (!e || e.localAt + 30 > buf.length || buf.readUInt32LE(e.localAt) !== LOC_SIG) throw new Error('corrupt zip entry');
    const nameLen = buf.readUInt16LE(e.localAt + 26);
    const extraLen = buf.readUInt16LE(e.localAt + 28);
    const start = e.localAt + 30 + nameLen + extraLen;
    const raw = buf.slice(start, start + e.compSize);
    if (e.method === 0) return raw;                       // stored
    if (e.method === 8) return inflateRaw(raw);           // deflate
    throw new Error('unsupported zip compression method ' + e.method);
  }
  const readText = (buf, entries, name, inflateRaw) => {
    const e = entries.get(name);
    return e ? entryBytes(buf, e, inflateRaw).toString('utf8') : null;
  };

  /* ---- XML, at exactly the depth these two formats need ---- */
  function unescapeXml(s) {
    return String(s)
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } })
      .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ''; } })
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');   // LAST: an escaped &amp;lt; must not become '<'
  }
  const stripTags = (s) => unescapeXml(String(s).replace(/<[^>]*>/g, ''));

  function docxText(buf, entries, inflateRaw) {
    const xml = readText(buf, entries, 'word/document.xml', inflateRaw);
    if (xml == null) throw new Error('not a Word document (no word/document.xml)');
    const withBreaks = xml
      .replace(/<w:tab\b[^>]*\/?>/g, '\t')
      .replace(/<w:br\b[^>]*\/?>/g, '\n')
      .replace(/<\/w:p>/g, '\n');       // a paragraph end is the only reliable line boundary in OOXML
    return stripTags(withBreaks).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function sharedStrings(buf, entries, inflateRaw) {
    const xml = readText(buf, entries, 'xl/sharedStrings.xml', inflateRaw);
    if (!xml) return [];
    // Each <si> is one string, possibly split across several <t> runs by formatting — join the runs.
    return (xml.match(/<si\b[\s\S]*?<\/si>|<si\b[^>]*\/>/g) || []).map(si => {
      const runs = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
      return runs.map(t => unescapeXml(t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join('');
    });
  }
  function sheetNames(buf, entries, inflateRaw) {
    const wb = readText(buf, entries, 'xl/workbook.xml', inflateRaw);
    if (!wb) return [];
    return (wb.match(/<sheet\b[^>]*\/?>/g) || []).map(s => {
      const m = /name="([^"]*)"/.exec(s);
      return m ? unescapeXml(m[1]) : '';
    });
  }
  function xlsxText(buf, entries, inflateRaw) {
    const shared = sharedStrings(buf, entries, inflateRaw);
    const names = sheetNames(buf, entries, inflateRaw);
    // Sort numerically: sheet10.xml must not sort between sheet1.xml and sheet2.xml.
    const sheets = Array.from(entries.keys()).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => (parseInt(/(\d+)\.xml$/.exec(a)[1], 10) - parseInt(/(\d+)\.xml$/.exec(b)[1], 10)));
    if (!sheets.length) throw new Error('not an Excel workbook (no xl/worksheets/sheet*.xml)');
    const out = [];
    sheets.forEach((sheetName, si) => {
      const xml = readText(buf, entries, sheetName, inflateRaw) || '';
      const rows = xml.match(/<row\b[\s\S]*?<\/row>|<row\b[^>]*\/>/g) || [];
      const lines = [];
      for (const row of rows.slice(0, MAX_SHEET_ROWS)) {
        const cells = (row.match(/<c\b[\s\S]*?<\/c>|<c\b[^>]*\/>/g) || []).slice(0, MAX_ROW_CELLS).map(c => {
          const type = (/\bt="([^"]*)"/.exec(c) || [])[1] || 'n';
          if (type === 'inlineStr') {
            const runs = c.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
            return runs.map(t => unescapeXml(t.replace(/^<t\b[^>]*>/, '').replace(/<\/t>$/, ''))).join('');
          }
          const v = /<v>([\s\S]*?)<\/v>/.exec(c);
          if (!v) return '';
          if (type === 's') { const i = parseInt(v[1], 10); return (i >= 0 && i < shared.length) ? shared[i] : ''; }
          return unescapeXml(v[1]);   // numbers, dates-as-serials, booleans, cached formula results
        });
        // A row that is entirely empty carries nothing a reader would see.
        if (cells.some(c => c !== '')) lines.push(cells.join('\t'));
      }
      const label = names[si] || ('sheet' + (si + 1));
      out.push('### ' + label + (rows.length > MAX_SHEET_ROWS ? ' (first ' + MAX_SHEET_ROWS + ' of ' + rows.length + ' rows)' : '') + '\n' + lines.join('\n'));
    });
    return out.join('\n\n').trim();
  }

  function ipynbText(buf) {
    let nb;
    try { nb = JSON.parse(buf.toString('utf8')); } catch (_) { throw new Error('not a valid notebook (JSON parse failed)'); }
    const cells = Array.isArray(nb && nb.cells) ? nb.cells : null;
    if (!cells) throw new Error('not a valid notebook (no cells array)');
    const lang = (nb.metadata && nb.metadata.kernelspec && nb.metadata.kernelspec.language) || 'python';
    const src = (s) => Array.isArray(s) ? s.join('') : String(s == null ? '' : s);
    const out = [];
    cells.forEach((cell, i) => {
      const body = src(cell && cell.source).replace(/\s+$/, '');
      const kind = (cell && cell.cell_type) || 'code';
      if (kind === 'markdown') { if (body) out.push(body); return; }
      if (kind === 'raw') { if (body) out.push('```\n' + body + '\n```'); return; }
      out.push('```' + lang + '  # cell ' + (i + 1) + '\n' + body + '\n```');
      // Outputs are why a notebook is worth reading — the RESULT is usually the answer, not the code.
      for (const o of (Array.isArray(cell.outputs) ? cell.outputs : [])) {
        if (!o) continue;
        if (o.output_type === 'stream') { const t = src(o.text).replace(/\s+$/, ''); if (t) out.push('[output]\n' + t); continue; }
        if (o.output_type === 'error') { out.push('[error] ' + String(o.ename || '') + ': ' + String(o.evalue || '')); continue; }
        const d = o.data || {};
        const t = d['text/plain'] ? src(d['text/plain']).replace(/\s+$/, '') : '';
        if (t) out.push('[output]\n' + t);
        else if (Object.keys(d).length) out.push('[output: ' + Object.keys(d).join(', ') + ' — not text, omitted]');
      }
    });
    return out.join('\n\n').trim();
  }

  function makeDocExtract(deps) {
    deps = deps || {};
    const inflateRaw = deps.inflateRaw;
    if (typeof inflateRaw !== 'function') throw new Error('docextract requires { inflateRaw }');

    function extract(buf, kind, opts) {
      opts = opts || {};
      const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : DEFAULT_MAX_CHARS;
      if (!buf || !buf.length) return '';
      let text;
      if (kind === 'ipynb') text = ipynbText(buf);
      else {
        const entries = readEntries(buf);
        let budget = MAX_TOTAL_INFLATE;
        const bounded = raw => {
          if (budget <= 0) throw new Error('document expands past the extraction budget');
          // zlib honours maxOutputLength and throws ERR_BUFFER_TOO_LARGE instead of allocating past it.
          const out = inflateRaw(raw, { maxOutputLength: Math.min(MAX_ENTRY_INFLATE, budget) });
          budget -= out.length;
          return out;
        };
        text = kind === 'docx' ? docxText(buf, entries, bounded) : xlsxText(buf, entries, bounded);
      }
      if (text.length > maxChars) return text.slice(0, maxChars) + '\n…[truncated]';
      return text;
    }

    return { sniff, extract, _internals: { MAX_ENTRY_INFLATE, MAX_TOTAL_INFLATE, readEntries, entryBytes, unescapeXml, stripTags, docxText, xlsxText, ipynbText, findEocd } };
  }

  return { makeDocExtract, sniff, _internals: { unescapeXml, stripTags, findEocd } };
});

/**
 * Minimal, zero-dependency .xlsx writer.
 *
 * The repo keeps the web app dependency-free (see apps/web/package.json), so
 * rather than pull in exceljs/sheetjs we emit a valid single-sheet workbook by
 * hand: a STORE-only ZIP (no compression, so no deflate needed) of the handful
 * of XML parts Excel/Numbers/LibreOffice require. Strings are written inline
 * (t="inlineStr") to avoid a shared-strings table.
 *
 * Public API: `downloadXlsx(filename, sheetName, rows)` where `rows` is a 2D
 * array of string | number cells (row 0 is treated as the header by callers,
 * but this module makes no assumption about it).
 */

export type Cell = string | number;

// ---- CRC32 (for the ZIP entries) ----

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(bytes: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- XML helpers ----

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 0 → "A", 25 → "Z", 26 → "AA". */
function colLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function isNumericCell(v: Cell): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function sheetXml(rows: Cell[][]): string {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${colLetter(c)}${r + 1}`;
          if (isNumericCell(cell)) return `<c r="${ref}"><v>${cell}</v></c>`;
          const text = xmlEscape(String(cell ?? ''));
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${body}</sheetData></worksheet>`
  );
}

function workbookXml(sheetName: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  );
}

const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  '</Relationships>';

const WORKBOOK_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
  '</Relationships>';

// ---- ZIP (STORE / no compression) ----

interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

function pushU16(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff);
}
function pushU32(out: number[], v: number): void {
  out.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
}
function pushBytes(out: number[], bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]!);
}

function zip(files: Array<{ name: string; content: string }>): Uint8Array {
  const enc = new TextEncoder();
  const out: number[] = [];
  const entries: ZipEntry[] = [];

  for (const f of files) {
    const data = enc.encode(f.content);
    const nameBytes = enc.encode(f.name);
    const crc = crc32(data);
    const offset = out.length;
    // local file header
    pushU32(out, 0x04034b50);
    pushU16(out, 20); // version needed
    pushU16(out, 0); // flags
    pushU16(out, 0); // compression = store
    pushU16(out, 0); // mod time
    pushU16(out, 0); // mod date
    pushU32(out, crc);
    pushU32(out, data.length); // compressed size (== uncompressed for store)
    pushU32(out, data.length); // uncompressed size
    pushU16(out, nameBytes.length);
    pushU16(out, 0); // extra length
    pushBytes(out, nameBytes);
    pushBytes(out, data);
    entries.push({ name: f.name, data, crc, offset });
  }

  const cdStart = out.length;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    pushU32(out, 0x02014b50); // central dir header
    pushU16(out, 20); // version made by
    pushU16(out, 20); // version needed
    pushU16(out, 0); // flags
    pushU16(out, 0); // compression
    pushU16(out, 0); // mod time
    pushU16(out, 0); // mod date
    pushU32(out, e.crc);
    pushU32(out, e.data.length);
    pushU32(out, e.data.length);
    pushU16(out, nameBytes.length);
    pushU16(out, 0); // extra
    pushU16(out, 0); // comment
    pushU16(out, 0); // disk number
    pushU16(out, 0); // internal attrs
    pushU32(out, 0); // external attrs
    pushU32(out, e.offset);
    pushBytes(out, nameBytes);
  }
  const cdSize = out.length - cdStart;

  // end of central directory
  pushU32(out, 0x06054b50);
  pushU16(out, 0); // disk number
  pushU16(out, 0); // disk with cd
  pushU16(out, entries.length);
  pushU16(out, entries.length);
  pushU32(out, cdSize);
  pushU32(out, cdStart);
  pushU16(out, 0); // comment length

  return Uint8Array.from(out);
}

/** Build a single-sheet .xlsx workbook as bytes. */
export function buildXlsx(sheetName: string, rows: Cell[][]): Uint8Array {
  return zip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    { name: '_rels/.rels', content: ROOT_RELS },
    { name: 'xl/workbook.xml', content: workbookXml(sheetName) },
    { name: 'xl/_rels/workbook.xml.rels', content: WORKBOOK_RELS },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml(rows) },
  ]);
}

/** Build the workbook and trigger a browser download. */
export function downloadXlsx(filename: string, sheetName: string, rows: Cell[][]): void {
  const bytes = buildXlsx(sheetName, rows);
  // Copy into a fresh ArrayBuffer-backed view so Blob gets a clean buffer.
  const blob = new Blob([bytes.slice()], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

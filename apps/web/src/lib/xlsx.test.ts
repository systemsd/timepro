import { describe, expect, it } from 'vitest';
import { buildXlsx } from './xlsx';

/** Find a 4-byte little-endian signature anywhere in the buffer. */
function hasSignature(bytes: Uint8Array, sig: [number, number, number, number]): boolean {
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === sig[0] && bytes[i + 1] === sig[1] && bytes[i + 2] === sig[2] && bytes[i + 3] === sig[3]) {
      return true;
    }
  }
  return false;
}

describe('buildXlsx', () => {
  const rows: (string | number)[][] = [
    ['Employee', 'Project', 'Seconds'],
    ['Alice', 'Website "v2"', 35220],
    ['Bob', 'Ops & <infra>', 11100],
  ];
  const bytes = buildXlsx('Report', rows);
  // STORE (no compression) → the XML parts appear verbatim in the bytes.
  const text = Buffer.from(bytes).toString('latin1');

  it('produces a non-empty ZIP with local-header + end-of-central-directory signatures', () => {
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes[0]).toBe(0x50); // 'P' — local file header PK\x03\x04
    expect(bytes[1]).toBe(0x4b);
    expect(hasSignature(bytes, [0x50, 0x4b, 0x05, 0x06])).toBe(true); // EOCD
  });

  it('contains the required OOXML parts', () => {
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']) {
      expect(text).toContain(part);
    }
  });

  it('XML-escapes string cells', () => {
    expect(text).toContain('Website &quot;v2&quot;');
    expect(text).toContain('Ops &amp; &lt;infra&gt;');
  });

  it('emits numbers as numeric cells (so Excel can sum them)', () => {
    // numeric cells use <v>…</v>; string cells use t="inlineStr" with <is><t>…
    expect(text).toContain('<v>35220</v>');
    expect(text).toContain('<v>11100</v>');
    expect(text).not.toContain('inlineStr"><is><t xml:space="preserve">35220'); // not a string cell
  });
});

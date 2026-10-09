import zlib from 'node:zlib';

/**
 * A small Excel (.xlsx) writer: one sheet, a bold header row, real numbers and dates.
 * An .xlsx file is a zip of a few XML files, so this needs no library.
 *
 * - Numbers from the database arrive as text ("1180.00"); anything with a decimal point is
 *   written as a number so Excel can add it up. Whole-number text (phone, barcode, HSN, PIN)
 *   stays text, or Excel would turn a 13-digit barcode into 8.9E+12.
 * - Dates (YYYY-MM-DD) and timestamps become real Excel dates, so they sort and filter.
 * - Text is written as inline text, never as a formula, so a value starting with "=" is harmless.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Zip the given files (deflate). Enough of the format for Excel, LibreOffice and unzip tools. */
export function zip(files: { name: string; data: string | Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data;
    const packed = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}

// Characters XML 1.0 does not allow at all, even escaped.
const xml = (s: string) => s
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const column = (i: number): string => {
  let name = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const DAY = 86400000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const IST = 5.5 * 3600000;

type Cell = { kind: 'n' | 'd' | 't' | 's'; value: string; width: number };

function cell(v: unknown): Cell | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || typeof v === 'bigint') return Number.isFinite(Number(v)) ? { kind: 'n', value: String(v), width: String(v).length } : null;
  if (typeof v === 'boolean') return { kind: 's', value: v ? 'Yes' : 'No', width: 3 };
  if (v instanceof Date) return { kind: 't', value: String((v.getTime() + IST - EXCEL_EPOCH) / DAY), width: 16 };
  if (typeof v === 'object') {
    const text = JSON.stringify(v);
    return { kind: 's', value: text, width: text.length };
  }
  const s = String(v);
  if (/^-?\d{1,15}\.\d{1,6}$/.test(s)) return { kind: 'n', value: s, width: s.length };
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T00:00:00Z`);
    if (!Number.isNaN(t)) return { kind: 'd', value: String((t - EXCEL_EPOCH) / DAY), width: 10 };
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) {
    const t = Date.parse(s);
    // Shown in India time, like everywhere else in the app.
    if (!Number.isNaN(t)) return { kind: 't', value: String((t + IST - EXCEL_EPOCH) / DAY), width: 16 };
  }
  return { kind: 's', value: s, width: s.length };
}

const heading = (key: string) => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function toXlsx(rows: Record<string, unknown>[], columns?: string[], sheetName = 'Sheet1'): Buffer {
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const widths = cols.map((c) => heading(c).length);
  const out: string[] = [];
  out.push(`<row r="1">${cols.map((c, i) => `<c r="${column(i)}1" t="inlineStr" s="1"><is><t>${xml(heading(c))}</t></is></c>`).join('')}</row>`);
  rows.forEach((row, r) => {
    const cells: string[] = [];
    cols.forEach((key, i) => {
      const c = cell(row[key]);
      if (!c) return;
      widths[i] = Math.max(widths[i]!, c.width);
      const ref = `${column(i)}${r + 2}`;
      if (c.kind === 's') cells.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(c.value)}</t></is></c>`);
      else cells.push(`<c r="${ref}"${c.kind === 'd' ? ' s="2"' : c.kind === 't' ? ' s="3"' : ''}><v>${c.value}</v></c>`);
    });
    out.push(`<row r="${r + 2}">${cells.join('')}</row>`);
  });
  const colsXml = widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(Math.max(w + 2, 8), 60)}" customWidth="1"/>`).join('');
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols.length ? `<cols>${colsXml}</cols>` : ''}<sheetData>${out.join('')}</sheetData></worksheet>`;

  return zip([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1')}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
    // Styles: 0 = normal, 1 = bold header, 2 = date, 3 = date and time.
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="dd\\-mm\\-yyyy"/><numFmt numFmtId="165" formatCode="dd\\-mm\\-yyyy\\ hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

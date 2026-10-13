import PDFDocument from 'pdfkit';

/**
 * Makes bank-statement PDFs for the tests, the way banks lay them out: details at the top, a table
 * with a heading row, figures set against the right edge of their columns, narrations that run on
 * to a second line, the heading repeated on each page and notes at the foot.
 */

export type Col = {
  title: string;
  /** A second line of the heading, printed under the first ("Date" under "Transaction"). */
  under?: string;
  /** Left edge of the column and its width, in points. */
  x: number;
  w: number;
  /** How the body is set (figures are 'right'), and the heading when it differs. */
  align?: 'left' | 'right';
  headAlign?: 'left' | 'right' | 'center';
};

export type StatementLayout = {
  cols: Col[];
  rows: string[][];
  /** Text printed above the table. */
  top?: string[];
  /** A line between the heading and the first transaction (an opening balance). */
  opening?: string[];
  /** Text printed after the table. */
  foot?: string[];
  rowsPerPage?: number;
  password?: string;
  fontSize?: number;
};

export function statementPdf(layout: StatementLayout): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 30, ...(layout.password ? { userPassword: layout.password, ownerPassword: 'the-bank-keeps-this-one' } : {}),
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const size = layout.fontSize ?? 7;
    const place = (text: string, col: Col, y: number, align: 'left' | 'right' | 'center') => {
      const width = doc.widthOfString(text);
      const x = align === 'right' ? col.x + col.w - width - 2 : align === 'center' ? col.x + (col.w - width) / 2 : col.x + 2;
      doc.text(text, x, y, { lineBreak: false });
    };
    const heading = (y: number) => {
      for (const col of layout.cols) {
        const align = col.headAlign ?? col.align ?? 'left';
        place(col.title, col, y, align);
        if (col.under) place(col.under, col, y + size + 2, align);
      }
      return y + (layout.cols.some((c) => c.under) ? 2 * size + 8 : size + 6);
    };
    /** A row; text wider than its column runs on to the next line, as a narration does. */
    const line = (cells: string[], y: number) => {
      let depth = 1;
      cells.forEach((text, i) => {
        const col = layout.cols[i]!;
        if (!text) return;
        if ((col.align ?? 'left') === 'right') return place(text, col, y, 'right');
        const words = text.split(' ');
        let current = '';
        let row = 0;
        for (const word of words) {
          const next = current ? `${current} ${word}` : word;
          if (current && doc.widthOfString(next) > col.w - 4) {
            place(current, col, y + row * (size + 2), 'left');
            row++;
            current = word;
          } else current = next;
        }
        place(current, col, y + row * (size + 2), 'left');
        depth = Math.max(depth, row + 1);
      });
      return y + depth * (size + 2) + 3;
    };

    doc.fontSize(size + 3);
    let y = 30;
    for (const t of layout.top ?? []) { doc.text(t, 32, y, { lineBreak: false }); y += size + 8; }
    doc.fontSize(size);
    y = heading(y + 14);
    if (layout.opening) y = line(layout.opening, y);
    const perPage = layout.rowsPerPage ?? 1000;
    layout.rows.forEach((row, i) => {
      if (i > 0 && i % perPage === 0) {
        doc.text(`Page ${i / perPage} of ${Math.ceil(layout.rows.length / perPage)}`, 260, 800, { lineBreak: false });
        doc.addPage();
        doc.fontSize(size);
        y = heading(40);
      }
      y = line(row, y);
    });
    y += 30;
    for (const t of layout.foot ?? []) { doc.text(t, 32, y, { lineBreak: false }); y += size + 4; }
    doc.end();
  });
}

/** Columns as a typical statement has them: two dates, narration, cheque number, debit, credit, balance. */
export const USUAL_COLS: Col[] = [
  { title: 'Transaction Date', x: 30, w: 62 },
  { title: 'Value Date', x: 92, w: 52 },
  { title: 'Particulars', x: 144, w: 170 },
  { title: 'Cheque No.', x: 314, w: 56 },
  { title: 'Debit', x: 370, w: 60, align: 'right', headAlign: 'left' },
  { title: 'Credit', x: 430, w: 60, align: 'right', headAlign: 'left' },
  { title: 'Balance', x: 490, w: 75, align: 'right', headAlign: 'left' },
];

/**
 * Minimal, dependency-free PDF writer (PDF 1.4, A4, Helvetica).
 *
 * Written in-tree rather than pulled from a package so that producing an
 * official election report does not depend on a third-party library or a CDN,
 * and so the generated file can be inspected: content streams are left
 * uncompressed, so the text of a report is readable with a plain text viewer
 * or `strings` on the .pdf itself.
 *
 * Output is a pure function of its input (including the supplied timestamp),
 * so the same count always yields a byte-identical PDF whose SHA-256 can be
 * recorded and re-verified.
 */

/* ------------------------------------------------------------------ *
 * Font metrics (Adobe AFM widths, per 1000 units of type size)
 * ------------------------------------------------------------------ */

const HELVETICA_WIDTHS = {
  ' ': 278, '!': 278, '"': 355, '#': 556, $: 556, '%': 889, '&': 667, "'": 191,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, _: 556, '`': 333,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
};

const HELVETICA_BOLD_WIDTHS = {
  ' ': 278, '!': 333, '"': 474, '#': 556, $: 556, '%': 889, '&': 722, "'": 238,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
  ':': 333, ';': 333, '<': 584, '=': 584, '>': 584, '?': 611, '@': 975,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556,
  K: 722, L: 611, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 333, '\\': 278, ']': 333, '^': 584, _: 556, '`': 333,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278,
  k: 556, l: 278, m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333,
  u: 611, v: 556, w: 778, x: 556, y: 556, z: 500,
  '{': 389, '|': 280, '}': 389, '~': 584,
};

/** Accented Latin-1 letters take the width of their base letter. */
const ACCENT_BASE = {
  'À': 'A', 'Á': 'A', 'Â': 'A', 'Ã': 'A', 'Ä': 'A', 'Å': 'A',
  'Æ': 'W', 'Ç': 'C', 'È': 'E', 'É': 'E', 'Ê': 'E', 'Ë': 'E',
  'Ì': 'I', 'Í': 'I', 'Î': 'I', 'Ï': 'I', 'Ñ': 'N', 'Ò': 'O',
  'Ó': 'O', 'Ô': 'O', 'Õ': 'O', 'Ö': 'O', 'Ø': 'O', 'Ù': 'U',
  'Ú': 'U', 'Û': 'U', 'Ü': 'U', 'Ý': 'Y', 'ß': 'B',
  'à': 'a', 'á': 'a', 'â': 'a', 'ã': 'a', 'ä': 'a', 'å': 'a',
  'æ': 'w', 'ç': 'c', 'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
  'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i', 'ñ': 'n', 'ò': 'o',
  'ó': 'o', 'ô': 'o', 'õ': 'o', 'ö': 'o', 'ø': 'o', 'ù': 'u',
  'ú': 'u', 'û': 'u', 'ü': 'u', 'ý': 'y', 'ÿ': 'y',
};

/**
 * Reduce text to characters the base fonts can render. Typographic punctuation
 * is transliterated rather than dropped so that nothing in a legal report is
 * silently lost; anything still unrepresentable becomes '?'.
 */
export const toWinAnsi = (value) => {
  const text = String(value ?? '');
  let output = '';

  for (const character of text) {
    const code = character.codePointAt(0);

    if (code === 0x2018 || code === 0x2019 || code === 0x201b) {
      output += "'";
    } else if (code === 0x201c || code === 0x201d || code === 0x201f) {
      output += '"';
    } else if (code === 0x2013) {
      output += '-';
    } else if (code === 0x2014) {
      output += '--';
    } else if (code === 0x2026) {
      output += '...';
    } else if (code === 0x2022) {
      output += '*';
    } else if (code === 0x00a0) {
      output += ' ';
    } else if (code === 0x0009) {
      output += '    ';
    } else if (code >= 0x20 && code <= 0x7e) {
      output += character;
    } else if (code >= 0xa0 && code <= 0xff) {
      output += character;
    } else {
      output += '?';
    }
  }

  return output;
};

const FONTS = {
  regular: { resource: 'F1', widths: HELVETICA_WIDTHS },
  bold: { resource: 'F2', widths: HELVETICA_BOLD_WIDTHS },
};

/** Width of `text` in points at `size`, for a WinAnsi-safe string. */
export const measureText = (text, size, fontName = 'regular') => {
  const { widths } = FONTS[fontName] ?? FONTS.regular;
  let total = 0;

  for (const character of text) {
    const direct = widths[character];
    if (direct !== undefined) {
      total += direct;
      continue;
    }
    const base = ACCENT_BASE[character];
    total += base !== undefined ? widths[base] ?? 556 : 556;
  }

  return (total * size) / 1000;
};

/** Greedy word wrap. Words longer than the column are broken by character. */
export const wrapText = (text, maxWidth, size, fontName = 'regular') => {
  const safe = toWinAnsi(text);
  const lines = [];

  safe.split('\n').forEach((paragraph) => {
    const words = paragraph.split(/\s+/).filter((word) => word.length > 0);

    if (words.length === 0) {
      lines.push('');
      return;
    }

    let current = '';

    const pushCurrent = () => {
      if (current !== '') {
        lines.push(current);
        current = '';
      }
    };

    words.forEach((word) => {
      const candidate = current === '' ? word : `${current} ${word}`;

      if (measureText(candidate, size, fontName) <= maxWidth) {
        current = candidate;
        return;
      }

      pushCurrent();

      if (measureText(word, size, fontName) <= maxWidth) {
        current = word;
        return;
      }

      // Break an over-long token (for example a digest) across lines.
      let chunk = '';
      for (const character of word) {
        if (measureText(chunk + character, size, fontName) > maxWidth && chunk !== '') {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      current = chunk;
    });

    pushCurrent();
  });

  return lines.length > 0 ? lines : [''];
};

const escapePdfText = (text) => text.replace(/([\\()])/g, '\\$1');

/* ------------------------------------------------------------------ *
 * Document builder
 * ------------------------------------------------------------------ */

const A4 = { width: 595.28, height: 841.89 };

export class PdfDocument {
  /**
   * @param {Object} options
   * @param {string} options.title     document title (PDF metadata)
   * @param {string} [options.subject]
   * @param {string} [options.footer]  left-hand footer text on every page
   * @param {Date}   [options.created] timestamp written to the PDF metadata
   */
  constructor({ title, subject = '', footer = '', created = new Date() } = {}) {
    this.title = toWinAnsi(title ?? 'Report');
    this.subject = toWinAnsi(subject);
    this.footer = toWinAnsi(footer);
    this.created = created;

    this.margin = { top: 56, right: 48, bottom: 56, left: 48 };
    this.contentWidth = A4.width - this.margin.left - this.margin.right;

    this.pages = [];
    this.operations = null;
    this.y = 0;

    this.addPage();
  }

  get bottomLimit() {
    return A4.height - this.margin.bottom;
  }

  addPage() {
    this.operations = [];
    this.pages.push(this.operations);
    this.y = this.margin.top;
  }

  /** Start a new page unless `height` still fits on the current one. */
  reserve(height) {
    if (this.y + height > this.bottomLimit) {
      this.addPage();
      return true;
    }
    return false;
  }

  pageBreak() {
    if (this.operations.length > 0) {
      this.addPage();
    }
  }

  /* ---- primitive drawing (y measured from the top of the page) ---- */

  drawText(text, { x, y, size = 10, font = 'regular', gray = 0 }) {
    const resource = (FONTS[font] ?? FONTS.regular).resource;
    const baseline = A4.height - y - size;

    this.operations.push(
      `BT ${gray} g /${resource} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${baseline.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`,
    );
  }

  drawLine({ x1, y1, x2, y2, width = 0.6, gray = 0.75 }) {
    this.operations.push(
      `${gray} G ${width} w ${x1.toFixed(2)} ${(A4.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(A4.height - y2).toFixed(2)} l S`,
    );
  }

  drawRect({ x, y, width, height, gray = 0.93 }) {
    this.operations.push(
      `${gray} g ${x.toFixed(2)} ${(A4.height - y - height).toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)} re f`,
    );
  }

  /* ---- layout blocks ---- */

  spacer(height = 10) {
    this.y += height;
  }

  rule(gapBefore = 6, gapAfter = 10) {
    this.y += gapBefore;
    this.reserve(1);
    this.drawLine({
      x1: this.margin.left,
      y1: this.y,
      x2: this.margin.left + this.contentWidth,
      y2: this.y,
      gray: 0.8,
    });
    this.y += gapAfter;
  }

  /**
   * @param {string} text
   * @param {Object} [options] size, font, gray, leading, gapBefore, gapAfter, indent
   */
  paragraph(text, options = {}) {
    const {
      size = 10,
      font = 'regular',
      gray = 0.15,
      leading = size * 1.42,
      gapBefore = 0,
      gapAfter = 6,
      indent = 0,
    } = options;

    this.y += gapBefore;

    const lines = wrapText(text, this.contentWidth - indent, size, font);

    lines.forEach((line) => {
      this.reserve(leading);
      this.drawText(line, { x: this.margin.left + indent, y: this.y, size, font, gray });
      this.y += leading;
    });

    this.y += gapAfter;
  }

  title1(text) {
    this.paragraph(text, { size: 19, font: 'bold', gray: 0, gapAfter: 4 });
  }

  heading(text) {
    // Keep a heading with at least a little of what follows.
    this.reserve(46);
    this.y += 10;
    this.paragraph(text, { size: 12.5, font: 'bold', gray: 0, gapAfter: 2 });
    this.drawLine({
      x1: this.margin.left,
      y1: this.y,
      x2: this.margin.left + this.contentWidth,
      y2: this.y,
      gray: 0.7,
      width: 1,
    });
    this.y += 9;
  }

  /** A boxed statement for the declaration and for referral notices. */
  callout(lines, { gray = 0.95, borderGray = 0.4 } = {}) {
    const padding = 10;
    const entries = lines.map((line) => ({
      size: line.size ?? 11,
      font: line.font ?? 'regular',
      lines: wrapText(line.text, this.contentWidth - padding * 2, line.size ?? 11, line.font ?? 'regular'),
      gapAfter: line.gapAfter ?? 3,
    }));

    const height =
      padding * 2 +
      entries.reduce(
        (total, entry) => total + entry.lines.length * entry.size * 1.4 + entry.gapAfter,
        0,
      );

    this.reserve(height);

    const top = this.y;
    this.drawRect({ x: this.margin.left, y: top, width: this.contentWidth, height, gray });
    this.drawLine({
      x1: this.margin.left,
      y1: top,
      x2: this.margin.left,
      y2: top + height,
      width: 3,
      gray: borderGray,
    });

    let cursor = top + padding;
    entries.forEach((entry) => {
      entry.lines.forEach((line) => {
        this.drawText(line, {
          x: this.margin.left + padding,
          y: cursor,
          size: entry.size,
          font: entry.font,
          gray: 0,
        });
        cursor += entry.size * 1.4;
      });
      cursor += entry.gapAfter;
    });

    this.y = top + height + 10;
  }

  /** Two-column label/value list. */
  definitions(rows, { labelWidth = 190, size = 10 } = {}) {
    rows.forEach(([label, value]) => {
      const labelLines = wrapText(label, labelWidth - 8, size, 'bold');
      const valueLines = wrapText(String(value), this.contentWidth - labelWidth, size, 'regular');
      const leading = size * 1.42;
      const height = Math.max(labelLines.length, valueLines.length) * leading;

      this.reserve(height);
      const top = this.y;

      labelLines.forEach((line, index) => {
        this.drawText(line, {
          x: this.margin.left,
          y: top + index * leading,
          size,
          font: 'bold',
          gray: 0.25,
        });
      });

      valueLines.forEach((line, index) => {
        this.drawText(line, {
          x: this.margin.left + labelWidth,
          y: top + index * leading,
          size,
          font: 'regular',
          gray: 0,
        });
      });

      this.y = top + height + 2;
    });

    this.y += 6;
  }

  /**
   * Table with a repeating header row.
   *
   * @param {Object} table
   * @param {Array<{header:string, width:number, align?:'left'|'right'|'center', font?:string}>} table.columns
   *        widths are relative and are scaled to the content width
   * @param {Array<Array<string>>} table.rows
   * @param {Array<boolean>} [table.emphasise] rows to render in bold
   */
  table({ columns, rows, emphasise = [], size = 9.5, caption = null }) {
    if (caption) {
      this.paragraph(caption, { size: 9.5, font: 'bold', gray: 0.3, gapAfter: 4 });
    }

    const totalWeight = columns.reduce((total, column) => total + column.width, 0);
    const widths = columns.map((column) => (column.width / totalWeight) * this.contentWidth);
    const offsets = [];
    widths.reduce((cursor, width) => {
      offsets.push(cursor);
      return cursor + width;
    }, this.margin.left);

    const padding = 5;
    const leading = size * 1.35;

    const drawHeader = () => {
      const headerLines = columns.map((column, index) =>
        wrapText(column.header, widths[index] - padding * 2, size, 'bold'),
      );
      const headerHeight = Math.max(...headerLines.map((lines) => lines.length)) * leading + padding * 2;

      this.reserve(headerHeight + leading + padding * 2);
      const top = this.y;

      this.drawRect({ x: this.margin.left, y: top, width: this.contentWidth, height: headerHeight, gray: 0.9 });

      headerLines.forEach((lines, index) => {
        lines.forEach((line, lineIndex) => {
          const align = columns[index].align ?? 'left';
          const lineWidth = measureText(line, size, 'bold');
          let x = offsets[index] + padding;
          if (align === 'right') {
            x = offsets[index] + widths[index] - padding - lineWidth;
          } else if (align === 'center') {
            x = offsets[index] + (widths[index] - lineWidth) / 2;
          }

          this.drawText(line, { x, y: top + padding + lineIndex * leading, size, font: 'bold', gray: 0 });
        });
      });

      this.y = top + headerHeight;
    };

    drawHeader();

    rows.forEach((row, rowIndex) => {
      const font = emphasise[rowIndex] ? 'bold' : 'regular';
      const cellLines = row.map((cell, index) =>
        wrapText(String(cell ?? ''), widths[index] - padding * 2, size, font),
      );
      const rowHeight = Math.max(...cellLines.map((lines) => lines.length)) * leading + padding * 1.6;

      if (this.y + rowHeight > this.bottomLimit) {
        this.addPage();
        drawHeader();
      }

      const top = this.y;

      if (emphasise[rowIndex]) {
        this.drawRect({ x: this.margin.left, y: top, width: this.contentWidth, height: rowHeight, gray: 0.96 });
      }

      cellLines.forEach((lines, index) => {
        lines.forEach((line, lineIndex) => {
          const align = columns[index].align ?? 'left';
          const lineWidth = measureText(line, size, font);
          let x = offsets[index] + padding;
          if (align === 'right') {
            x = offsets[index] + widths[index] - padding - lineWidth;
          } else if (align === 'center') {
            x = offsets[index] + (widths[index] - lineWidth) / 2;
          }

          this.drawText(line, { x, y: top + padding * 0.8 + lineIndex * leading, size, font, gray: 0.1 });
        });
      });

      this.drawLine({
        x1: this.margin.left,
        y1: top + rowHeight,
        x2: this.margin.left + this.contentWidth,
        y2: top + rowHeight,
        gray: 0.85,
      });

      this.y = top + rowHeight;
    });

    this.y += 10;
  }

  /** Ruled signature lines for the Returning Officer and scrutineers. */
  signatureBlock(roles) {
    const columnWidth = (this.contentWidth - 24) / 2;
    const blockHeight = 58;

    roles.forEach((role, index) => {
      if (index % 2 === 0) {
        this.reserve(blockHeight);
      }

      const column = index % 2;
      const x = this.margin.left + column * (columnWidth + 24);
      const top = this.y;

      this.drawText(toWinAnsi(role), { x, y: top, size: 9, font: 'bold', gray: 0.3 });
      this.drawLine({ x1: x, y1: top + 34, x2: x + columnWidth, y2: top + 34, gray: 0.5 });
      this.drawText('Name and signature', { x, y: top + 38, size: 7.5, gray: 0.45 });
      this.drawLine({ x1: x, y1: top + 56, x2: x + columnWidth, y2: top + 56, gray: 0.5 });

      if (column === 1 || index === roles.length - 1) {
        this.y = top + blockHeight + 10;
      }
    });
  }

  /* ---- serialisation ---- */

  /** Stamp the footer and page numbers once the page count is known. */
  stampFooters() {
    const total = this.pages.length;

    this.pages.forEach((operations, index) => {
      const previous = this.operations;
      this.operations = operations;

      const y = A4.height - this.margin.bottom + 18;

      this.drawLine({
        x1: this.margin.left,
        y1: y - 8,
        x2: this.margin.left + this.contentWidth,
        y2: y - 8,
        gray: 0.8,
      });

      if (this.footer) {
        this.drawText(this.footer, { x: this.margin.left, y, size: 7.5, gray: 0.4 });
      }

      const label = `Page ${index + 1} of ${total}`;
      this.drawText(label, {
        x: this.margin.left + this.contentWidth - measureText(label, 7.5),
        y,
        size: 7.5,
        gray: 0.4,
      });

      this.operations = previous;
    });
  }

  /** @returns {Uint8Array} the complete PDF file */
  toBytes() {
    this.stampFooters();

    const objects = [];
    const pageCount = this.pages.length;

    // 1 catalog, 2 pages, 3 info, 4+5 fonts, then page/content pairs.
    const firstPageObject = 6;
    const pageIds = this.pages.map((_, index) => firstPageObject + index * 2);

    objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objects[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;

    const pad = (value) => String(value).padStart(2, '0');
    const date = this.created;
    const stamp = `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(
      date.getUTCHours(),
    )}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;

    objects[3] =
      `<< /Title (${escapePdfText(this.title)}) /Subject (${escapePdfText(this.subject)}) ` +
      `/Producer (easy-vote) /Creator (easy-vote) /CreationDate (${stamp}) /ModDate (${stamp}) >>`;

    objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objects[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    this.pages.forEach((operations, index) => {
      const pageId = pageIds[index];
      const contentId = pageId + 1;
      const stream = operations.join('\n');

      objects[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] ` +
        `/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${contentId} 0 R >>`;

      objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
    });

    const header = '%PDF-1.4\n%âãÏÓ\n';
    let body = '';
    const offsets = [];
    const maxId = objects.length - 1;

    for (let id = 1; id <= maxId; id += 1) {
      offsets[id] = header.length + body.length;
      body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }

    const xrefOffset = header.length + body.length;
    let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= maxId; id += 1) {
      xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size ${maxId + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    const file = header + body + xref + trailer;

    const bytes = new Uint8Array(file.length);
    for (let index = 0; index < file.length; index += 1) {
      bytes[index] = file.charCodeAt(index) & 0xff;
    }

    return bytes;
  }
}

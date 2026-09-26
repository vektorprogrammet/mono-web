/**
 * The PDF of one recorded certificate issue, rendered on the server. It uses the standard
 * Helvetica fonts with WinAnsi encoding and embeds no font, so the same issue always renders the
 * same bytes. Text that WinAnsi cannot encode fails closed before the issue commits.
 */
import type { CertificateIssue } from "@vektorprogrammet/domain/placements";
import { Data, Result } from "effect";

/** A text on the certificate that the standard fonts cannot print. */
export class CertificateUnprintable extends Data.TaggedError("CertificateUnprintable")<{
  readonly field: "assistant" | "department" | "school" | "issuer" | "seat";
}> {}

/** The WinAnsi bytes of the code points above Latin-1 that the encoding has. */
const winAnsiExtras = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/** Helvetica advance widths in 1/1000 em for the WinAnsi bytes 32 to 255; 0 marks no glyph. */
const helveticaWidths = [
  // 32-63
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  // 64-95
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
  667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  // 96-127
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333,
  500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0,
  // 128-159
  556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333,
  333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667,
  // 160-191
  278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400, 584, 333,
  333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611,
  // 192-223
  667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778,
  778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611,
  // 224-255
  556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556, 500,
];

/** The WinAnsi bytes of a text, or none when a character has no glyph in the standard fonts. */
const winAnsi = (text: string): Result.Result<ReadonlyArray<number>, undefined> => {
  const bytes: Array<number> = [];

  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;

    const byte =
      (codePoint >= 0x20 && codePoint <= 0x7e) || (codePoint >= 0xa0 && codePoint <= 0xff)
        ? codePoint
        : winAnsiExtras.get(codePoint);

    if (byte === undefined) return Result.fail(undefined);

    bytes.push(byte);
  }

  return Result.succeed(bytes);
};

const PAGE_WIDTH = 595.28;

const PAGE_HEIGHT = 841.89;

const MARGIN = 62;

const BOTTOM = 72;

/** The bold face is at most about a tenth wider than the regular face. */
const BOLD_FACTOR = 1.1;

interface Font {
  readonly name: "F1" | "F2";
  readonly size: number;
}

const regular = (size: number): Font => ({ name: "F1", size });

const bold = (size: number): Font => ({ name: "F2", size });

const widthOf = (bytes: ReadonlyArray<number>, font: Font) =>
  (bytes.reduce((total, byte) => total + (helveticaWidths[byte - 32] ?? 0), 0) * font.size) /
  (font.name === "F2" ? 1000 / BOLD_FACTOR : 1000);

/** Breaks encoded text at spaces into lines no wider than `maxWidth`; a long word keeps its line. */
const wrap = (
  bytes: ReadonlyArray<number>,
  font: Font,
  maxWidth: number,
): ReadonlyArray<ReadonlyArray<number>> => {
  const words: Array<Array<number>> = [[]];

  for (const byte of bytes) {
    if (byte === 0x20) words.push([]);
    else words.at(-1)?.push(byte);
  }

  const lines: Array<ReadonlyArray<number>> = [];
  let line: ReadonlyArray<number> = [];

  for (const word of words.filter((candidate) => candidate.length > 0)) {
    const candidate = line.length === 0 ? word : [...line, 0x20, ...word];

    if (line.length > 0 && widthOf(candidate, font) > maxWidth) {
      lines.push(line);
      line = word;
    } else line = candidate;
  }

  return line.length === 0 ? lines : [...lines, line];
};

/** One byte inside a PDF literal string: delimiters escaped, bytes above ASCII as octal. */
const escaped = (byte: number) => {
  if (byte === 0x28 || byte === 0x29 || byte === 0x5c) return `\\${String.fromCharCode(byte)}`;

  return byte < 0x80 ? String.fromCharCode(byte) : `\\${byte.toString(8).padStart(3, "0")}`;
};

const number = (value: number) => value.toFixed(2).replace(/\.?0+$/u, "");

/** Content streams of pages laid out from the top; a line that does not fit opens a page. */
class Layout {
  readonly pages: Array<Array<string>> = [[]];
  #y = PAGE_HEIGHT - MARGIN;

  #room(height: number) {
    if (this.#y - height < BOTTOM) {
      this.pages.push([]);
      this.#y = PAGE_HEIGHT - MARGIN;
    }
  }

  #current() {
    return this.pages.at(-1) ?? [];
  }

  text(bytes: ReadonlyArray<number>, font: Font, x: number) {
    this.#current().push(
      `BT /${font.name} ${number(font.size)} Tf 1 0 0 1 ${number(x)} ${number(this.#y)} Tm (${bytes.map(escaped).join("")}) Tj ET`,
    );
  }

  /** One line of text, advanced by its leading. */
  line(bytes: ReadonlyArray<number>, font: Font, x = MARGIN) {
    const leading = font.size * 1.4;

    this.#room(leading);
    this.#y -= leading;
    this.text(bytes, font, x);
  }

  paragraph(bytes: ReadonlyArray<number>, font: Font) {
    for (const line of wrap(bytes, font, PAGE_WIDTH - 2 * MARGIN)) this.line(line, font);
  }

  /** A table row: every cell wraps in its column, and the row keeps its cells on one page. */
  row(cells: ReadonlyArray<readonly [ReadonlyArray<number>, number, number]>, font: Font) {
    const wrapped = cells.map(([bytes, x, width]) => [wrap(bytes, font, width), x] as const);
    const leading = font.size * 1.4;
    const height = Math.max(...wrapped.map(([lines]) => lines.length)) * leading;

    this.#room(height);

    const top = this.#y;

    for (const [lines, x] of wrapped) {
      this.#y = top;

      for (const line of lines) {
        this.#y -= leading;
        this.text(line, font, x);
      }
    }

    this.#y = top - height;
  }

  rule() {
    this.#room(8);
    this.#y -= 6;
    this.#current().push(
      `0.5 w ${number(MARGIN)} ${number(this.#y)} m ${number(PAGE_WIDTH - MARGIN)} ${number(this.#y)} l S`,
    );
  }

  gap(height: number) {
    this.#room(height);
    this.#y -= height;
  }
}

/** `2026-09-26` as `26.09.2026`. */
const norwegianDate = (isoDate: string) => isoDate.split("-").toReversed().join(".");

const encoder = new TextEncoder();

/** Serializes numbered objects with a cross-reference table. */
const serialize = (objects: ReadonlyArray<string>): Uint8Array<ArrayBuffer> => {
  // The binary marker after the header tells transfer tools that the file is not text.
  const header = [...encoder.encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a];
  const offsets: Array<number> = [];
  let body = "";

  for (const [index, object] of objects.entries()) {
    offsets.push(header.length + body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xref = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
  ].join("");

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 2 0 R >>\nstartxref\n${
    header.length + body.length
  }\n%%EOF\n`;

  return Uint8Array.from([...header, ...encoder.encode(body + xref + trailer)]);
};

/**
 * Renders one issue: the assistant, the department, every included semester with its schools
 * and confirmed days, the issuer's name and seat title, and the issue date.
 */
export const renderCertificatePdf = (
  issue: CertificateIssue,
): Result.Result<Uint8Array<ArrayBuffer>, CertificateUnprintable> =>
  Result.gen(function* () {
    const encode = (text: string, field: CertificateUnprintable["field"]) =>
      Result.mapError(winAnsi(text), () => new CertificateUnprintable({ field }));

    const fixed = (text: string) => Result.getOrThrow(winAnsi(text));
    const { content, issuer } = issue;
    const assistant = yield* encode(content.assistantName, "assistant");
    const department = yield* encode(content.departmentName, "department");
    const issuerName = yield* encode(issuer.name, "issuer");
    const seatTitle = yield* encode(issuer.seatTitle, "seat");

    const semesters = yield* Result.all(
      content.semesters.map((semester) =>
        Result.map(encode(semester.schools.join(", "), "school"), (schools) => ({
          period: fixed(`${norwegianDate(semester.startsOn)}–${norwegianDate(semester.endsOn)}`),
          schools,
          days: fixed(String(semester.days)),
        })),
      ),
    );

    const total = content.semesters.reduce((sum, semester) => sum + semester.days, 0);
    const layout = new Layout();
    const columns = { period: MARGIN, schools: MARGIN + 130, days: PAGE_WIDTH - MARGIN - 60 };
    const schoolsWidth = columns.days - columns.schools - 12;

    layout.line(fixed("Attest – Vektorprogrammet"), bold(20));
    layout.gap(18);
    layout.paragraph(
      [
        ...assistant,
        ...fixed(" har vært deltagende i Vektorprogrammet ved "),
        ...department,
        ...fixed(" som vektorassistent."),
      ],
      bold(11),
    );
    layout.gap(8);
    layout.paragraph(
      [
        ...fixed("I sitt arbeid for det frivillighetsbaserte Vektorprogrammet har "),
        ...assistant,
        ...fixed(
          " deltatt som assistent i matematikkundervisningen i skolen. Arbeidsoppgavene varierer fra undervisning i mindre grupper til oppgaveløsning i klasserommet. Oversikten viser semestrene, skolene og de bekreftede dagene med tjeneste.",
        ),
      ],
      regular(11),
    );
    layout.gap(14);
    layout.line(fixed("Assistentoversikt"), bold(13));
    layout.gap(4);
    layout.row(
      [
        [fixed("Semester"), columns.period, columns.schools - columns.period - 12],
        [fixed("Skoler"), columns.schools, schoolsWidth],
        [fixed("Dager"), columns.days, 60],
      ],
      bold(10.5),
    );
    layout.rule();

    for (const semester of semesters)
      layout.row(
        [
          [semester.period, columns.period, columns.schools - columns.period - 12],
          [semester.schools, columns.schools, schoolsWidth],
          [semester.days, columns.days, 60],
        ],
        regular(10.5),
      );

    layout.rule();
    layout.row(
      [
        [fixed("Totalt"), columns.period, columns.schools - columns.period - 12],
        [fixed(String(total)), columns.days, 60],
      ],
      bold(10.5),
    );
    layout.gap(30);
    layout.line(fixed("På vegne av Vektorprogrammet"), regular(11));
    layout.gap(12);
    layout.paragraph(issuerName, bold(11));
    layout.paragraph(seatTitle, regular(11));
    layout.line(fixed(`Utstedt ${norwegianDate(issue.issuedOn)}`), regular(11));

    const pageCount = layout.pages.length;
    // Objects: catalog, info, pages, two fonts, then a page and its content for each page.
    const pageObject = (index: number) => 6 + index * 2;

    const pages = layout.pages.flatMap((operations, index) => {
      const stream = operations.join("\n");

      return [
        `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${number(PAGE_WIDTH)} ${number(PAGE_HEIGHT)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents ${pageObject(index) + 1} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    });

    const created = issue.issuedAt.replace(/[-:]/gu, "").replace(/T/u, "").slice(0, 14);

    return serialize([
      "<< /Type /Catalog /Pages 3 0 R >>",
      `<< /Title (Attest) /Producer (Vektorprogrammet) /CreationDate (D:${created}Z) >>`,
      `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${pageObject(index)} 0 R`).join(" ")}] /Count ${pageCount} >>`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
      ...pages,
    ]);
  });

/**
 * The PDF of one recorded certificate issue, rendered on the server. It embeds subsets of Noto
 * Sans Regular and Bold under the SIL Open Font License (`fonts/provenance.json` names the release
 * and the checksums), so every name that the fonts cover prints, and the same issue always renders
 * the same bytes. Text that no embedded glyph covers fails closed before the issue commits.
 */
import type { CertificateIssue } from "@vektorprogrammet/domain/placements";
import { Context, Data, Effect, FileSystem, Layer, Path, Result } from "effect";
import { sha256Hex } from "../http-semantics.js";
import { parseTrueType, type TrueTypeFont, type TrueTypeSubset } from "./true-type.js";

/** A text on the certificate that no glyph of the embedded fonts covers. */
export class CertificateUnprintable extends Data.TaggedError("CertificateUnprintable")<{
  readonly field: "assistant" | "department" | "school" | "issuer" | "seat";
}> {}

/** The faces of the certificate. */
export interface CertificateFaces {
  readonly regular: TrueTypeFont;
  readonly bold: TrueTypeFont;
}

export class CertificateFonts extends Context.Service<CertificateFonts, CertificateFaces>()(
  "@vektorprogrammet/backend/CertificateFonts",
) {}

/** Reads and parses the certificate fonts once, when the process composes its handlers. */
export const CertificateFontsLive = Layer.effect(
  CertificateFonts,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const face = (file: string) =>
      path.fromFileUrl(new URL(`fonts/${file}`, import.meta.url)).pipe(
        Effect.flatMap((location) => fs.readFile(location)),
        Effect.flatMap((bytes) => Effect.fromResult(parseTrueType(bytes))),
      );

    return {
      regular: yield* face("NotoSans-Regular.ttf"),
      bold: yield* face("NotoSans-Bold.ttf"),
    };
  }).pipe(Effect.orDie),
);

/** Controls draw nothing that a reader could check, so they count as unprintable. */
const isControl = (codePoint: number) =>
  codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0);

/** The code points of a text in composed form, or none when a face lacks a glyph for one. */
const printable = (faces: CertificateFaces, text: string) => {
  const codePoints = Array.from(
    text.normalize("NFC"),
    (character) => character.codePointAt(0) ?? 0,
  );

  return codePoints.every(
    (codePoint) =>
      !isControl(codePoint) &&
      faces.regular.glyphOf(codePoint) !== 0 &&
      faces.bold.glyphOf(codePoint) !== 0,
  )
    ? Result.succeed<ReadonlyArray<number>>(codePoints)
    : Result.fail(undefined);
};

const PAGE_WIDTH = 595.28;

const PAGE_HEIGHT = 841.89;

const MARGIN = 62;

const BOTTOM = 72;

type Face = "F1" | "F2";

interface Font {
  readonly face: Face;
  readonly size: number;
}

const regular = (size: number): Font => ({ face: "F1", size });

const bold = (size: number): Font => ({ face: "F2", size });

/** One line of text at its position. Its glyphs are numbered once the subsets are known. */
interface Run {
  readonly font: Font;
  readonly x: number;
  readonly y: number;
  readonly text: ReadonlyArray<number>;
}

const number = (value: number) => value.toFixed(2).replace(/\.?0+$/u, "");

/** The text and the strokes of one page. */
interface Page {
  readonly runs: Array<Run>;
  readonly strokes: Array<string>;
}

/** Content of pages laid out from the top; a line that does not fit opens a page. */
class Layout {
  readonly pages: Array<Page> = [{ runs: [], strokes: [] }];
  readonly #faces: Readonly<Record<Face, TrueTypeFont>>;
  #y = PAGE_HEIGHT - MARGIN;

  constructor(faces: CertificateFaces) {
    this.#faces = { F1: faces.regular, F2: faces.bold };
  }

  #room(height: number) {
    if (this.#y - height < BOTTOM) {
      this.pages.push({ runs: [], strokes: [] });
      this.#y = PAGE_HEIGHT - MARGIN;
    }
  }

  #current(): Page {
    return this.pages.at(-1) ?? { runs: [], strokes: [] };
  }

  #width(text: ReadonlyArray<number>, font: Font) {
    const face = this.#faces[font.face];

    const units = text.reduce(
      (total, codePoint) => total + face.advanceOf(face.glyphOf(codePoint)),
      0,
    );

    return (units * font.size) / face.unitsPerEm;
  }

  /** Breaks text at spaces into lines no wider than `maxWidth`; a long word keeps its line. */
  #wrap(text: ReadonlyArray<number>, font: Font, maxWidth: number) {
    const words: Array<Array<number>> = [[]];

    for (const codePoint of text) {
      if (codePoint === 0x20) words.push([]);
      else words.at(-1)?.push(codePoint);
    }

    const lines: Array<ReadonlyArray<number>> = [];
    let line: ReadonlyArray<number> = [];

    for (const word of words.filter((candidate) => candidate.length > 0)) {
      const candidate = line.length === 0 ? word : [...line, 0x20, ...word];

      if (line.length > 0 && this.#width(candidate, font) > maxWidth) {
        lines.push(line);
        line = word;
      } else line = candidate;
    }

    return line.length === 0 ? lines : [...lines, line];
  }

  /** One line of text, advanced by its leading. */
  line(text: ReadonlyArray<number>, font: Font, x = MARGIN) {
    const leading = font.size * 1.4;

    this.#room(leading);
    this.#y -= leading;
    this.#current().runs.push({ font, x, y: this.#y, text });
  }

  paragraph(text: ReadonlyArray<number>, font: Font) {
    for (const line of this.#wrap(text, font, PAGE_WIDTH - 2 * MARGIN)) this.line(line, font);
  }

  /** A table row: every cell wraps in its column, and the row keeps its cells on one page. */
  row(cells: ReadonlyArray<readonly [ReadonlyArray<number>, number, number]>, font: Font) {
    const wrapped = cells.map(([text, x, width]) => [this.#wrap(text, font, width), x] as const);
    const leading = font.size * 1.4;
    const height = Math.max(...wrapped.map(([lines]) => lines.length)) * leading;

    this.#room(height);

    const top = this.#y;

    for (const [lines, x] of wrapped) {
      for (const [index, line] of lines.entries())
        this.#current().runs.push({ font, x, y: top - (index + 1) * leading, text: line });
    }

    this.#y = top - height;
  }

  rule() {
    this.#room(8);
    this.#y -= 6;
    this.#current().strokes.push(
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

const hex4 = (value: number) => value.toString(16).toUpperCase().padStart(4, "0");

/** A code point in UTF-16BE, as a ToUnicode map writes it. */
const utf16 = (codePoint: number) =>
  codePoint > 0xffff
    ? hex4(0xd800 + ((codePoint - 0x10000) >> 10)) + hex4(0xdc00 + ((codePoint - 0x10000) & 0x3ff))
    : hex4(codePoint);

/** One numbered object of the document: a dictionary, and the stream that follows it if any. */
interface PdfObject {
  readonly dictionary: string;
  readonly stream?: Uint8Array;
}

const stream = (bytes: Uint8Array, entries = ""): PdfObject => ({
  dictionary: `<< /Length ${bytes.length}${entries} >>`,
  stream: bytes,
});

/** Serializes numbered objects with a cross-reference table. */
const serialize = (objects: ReadonlyArray<PdfObject>): Uint8Array<ArrayBuffer> => {
  // The binary marker after the header tells transfer tools that the file is not text.
  const chunks: Array<Uint8Array> = [
    Uint8Array.from([...encoder.encode("%PDF-1.4\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ];

  const offsets: Array<number> = [];
  let length = chunks[0]?.length ?? 0;

  const append = (chunk: Uint8Array) => {
    chunks.push(chunk);
    length += chunk.length;
  };

  for (const [index, object] of objects.entries()) {
    offsets.push(length);

    if (object.stream === undefined)
      append(encoder.encode(`${index + 1} 0 obj\n${object.dictionary}\nendobj\n`));
    else {
      append(encoder.encode(`${index + 1} 0 obj\n${object.dictionary}\nstream\n`));
      append(object.stream);
      append(encoder.encode("\nendstream\nendobj\n"));
    }
  }

  const xref = length;

  append(
    encoder.encode(
      [
        `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
        ...offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
        `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 2 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      ].join(""),
    ),
  );

  const document = new Uint8Array(length);
  let position = 0;

  for (const chunk of chunks) {
    document.set(chunk, position);
    position += chunk.length;
  }

  return document;
};

/** The ToUnicode map of a subset: each drawn glyph and the character that it shows. */
const toUnicode = (characters: ReadonlyArray<readonly [number, number]>) => {
  const blocks: Array<string> = [];

  // A block maps at most 100 codes.
  for (let start = 0; start < characters.length; start += 100) {
    const block = characters.slice(start, start + 100);

    blocks.push(
      `${block.length} beginbfchar\n${block.map(([glyph, codePoint]) => `<${hex4(glyph)}> <${utf16(codePoint)}>`).join("\n")}\nendbfchar`,
    );
  }

  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /Adobe-Identity-UCS def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    ...blocks,
    "endcmap",
    "CMapName currentdict /defineresource pop",
    "end",
    "end",
  ].join("\n");
};

/**
 * The five objects of one embedded face, starting at object `first`: the composite font, its
 * glyph-indexed descendant, the descriptor, the subset program, and the ToUnicode map.
 */
const faceObjects = (
  first: number,
  font: TrueTypeFont,
  subset: TrueTypeSubset,
  characters: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<PdfObject> => {
  const scale = (value: number) => Math.round((value * 1000) / font.unitsPerEm);

  // A subset font's name starts with a tag of six capital letters that names the subset.
  const tag = Array.from(sha256Hex(subset.program).slice(0, 6), (digit) =>
    String.fromCharCode(65 + Number.parseInt(digit, 16)),
  ).join("");

  const name = `${tag}+${font.postScriptName}`;

  return [
    {
      dictionary: `<< /Type /Font /Subtype /Type0 /BaseFont /${name} /Encoding /Identity-H /DescendantFonts [${first + 1} 0 R] /ToUnicode ${first + 4} 0 R >>`,
    },
    {
      dictionary: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${first + 2} 0 R /W [0 [${subset.advances.map(scale).join(" ")}]] /CIDToGIDMap /Identity >>`,
    },
    {
      dictionary: `<< /Type /FontDescriptor /FontName /${name} /Flags 4 /FontBBox [${font.boundingBox.map(scale).join(" ")}] /ItalicAngle 0 /Ascent ${scale(font.ascent)} /Descent ${scale(font.descent)} /CapHeight ${scale(font.capHeight)} /StemV 80 /FontFile2 ${first + 3} 0 R >>`,
    },
    stream(subset.program, ` /Length1 ${subset.program.length}`),
    stream(encoder.encode(toUnicode(characters))),
  ];
};

/**
 * Renders one issue: the assistant, the department, every included semester with its schools
 * and confirmed days, the issuer's name and seat title, and the issue date.
 */
export const renderCertificatePdf = (
  issue: CertificateIssue,
  faces: CertificateFaces,
): Result.Result<Uint8Array<ArrayBuffer>, CertificateUnprintable> =>
  Result.gen(function* () {
    const encode = (text: string, field: CertificateUnprintable["field"]) =>
      Result.mapError(printable(faces, text), () => new CertificateUnprintable({ field }));

    // The fixed wording is Norwegian, which both faces cover.
    const fixed = (text: string) => Result.getOrThrow(printable(faces, text));
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
    const layout = new Layout(faces);
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

    const runs = layout.pages.flatMap((page) => page.runs);

    // Each face embeds the glyphs that its runs draw, numbered in the order that they appear.
    const embedded = (face: Face, font: TrueTypeFont) => {
      const drawn = new Map<number, number>();

      for (const run of runs.filter((candidate) => candidate.font.face === face))
        for (const codePoint of run.text) {
          const glyph = font.glyphOf(codePoint);

          if (!drawn.has(glyph)) drawn.set(glyph, codePoint);
        }

      const subset = font.subset(drawn.keys());

      return {
        font,
        subset,
        characters: [...drawn].map(
          ([glyph, codePoint]) => [subset.glyphs.get(glyph) ?? 0, codePoint] as const,
        ),
      };
    };

    const fonts = { F1: embedded("F1", faces.regular), F2: embedded("F2", faces.bold) };

    const textOperator = (run: Run) => {
      const { font, subset } = fonts[run.font.face];

      const glyphs = run.text
        .map((codePoint) => hex4(subset.glyphs.get(font.glyphOf(codePoint)) ?? 0))
        .join("");

      return `BT /${run.font.face} ${number(run.font.size)} Tf 1 0 0 1 ${number(run.x)} ${number(run.y)} Tm <${glyphs}> Tj ET`;
    };

    // Objects: catalog, info, pages, five for each face, then a page and its content per page.
    const pageObject = (index: number) => 14 + index * 2;
    const pageCount = layout.pages.length;

    const pages = layout.pages.flatMap(
      (page, index): ReadonlyArray<PdfObject> => [
        {
          dictionary: `<< /Type /Page /Parent 3 0 R /MediaBox [0 0 ${number(PAGE_WIDTH)} ${number(PAGE_HEIGHT)}] /Resources << /Font << /F1 4 0 R /F2 9 0 R >> >> /Contents ${pageObject(index) + 1} 0 R >>`,
        },
        stream(encoder.encode([...page.strokes, ...page.runs.map(textOperator)].join("\n"))),
      ],
    );

    const created = issue.issuedAt.replace(/[-:]/gu, "").replace(/T/u, "").slice(0, 14);

    return serialize([
      { dictionary: "<< /Type /Catalog /Pages 3 0 R >>" },
      {
        dictionary: `<< /Title (Attest) /Producer (Vektorprogrammet) /CreationDate (D:${created}Z) >>`,
      },
      {
        dictionary: `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${pageObject(index)} 0 R`).join(" ")}] /Count ${pageCount} >>`,
      },
      ...faceObjects(4, fonts.F1.font, fonts.F1.subset, fonts.F1.characters),
      ...faceObjects(9, fonts.F2.font, fonts.F2.subset, fonts.F2.characters),
      ...pages,
    ]);
  });

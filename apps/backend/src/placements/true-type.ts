/**
 * The part of a TrueType font program that a PDF needs: the glyph of a code point, its advance,
 * the metrics of a font descriptor, and a subset program with only the glyphs that a document
 * draws. It reads glyph outlines (`glyf`), not CFF, and it copies no hinting, which the unhinted
 * certificate fonts do not have.
 */
import { Data, Result } from "effect";

/** A font program that the reader cannot use. */
export class TrueTypeMalformed extends Data.TaggedError("TrueTypeMalformed")<{
  readonly reason: string;
}> {}

/** A glyph-outline font program and the metrics that a PDF font descriptor states. */
export interface TrueTypeFont {
  readonly postScriptName: string;
  readonly unitsPerEm: number;
  readonly boundingBox: readonly [number, number, number, number];
  readonly ascent: number;
  readonly descent: number;
  readonly capHeight: number;
  /** The glyph of a code point, or 0 (`.notdef`) when the font has none. */
  readonly glyphOf: (codePoint: number) => number;
  /** The advance width of a glyph in font units. */
  readonly advanceOf: (glyph: number) => number;
  /** A program of `.notdef`, the given glyphs in order, and the components that they use. */
  readonly subset: (glyphs: Iterable<number>) => TrueTypeSubset;
}

export interface TrueTypeSubset {
  /** The subset glyph of each glyph of the full font that the subset holds. */
  readonly glyphs: ReadonlyMap<number, number>;
  /** The advance width of each subset glyph in font units. */
  readonly advances: ReadonlyArray<number>;
  readonly program: Uint8Array<ArrayBuffer>;
}

interface Table {
  readonly offset: number;
  readonly length: number;
}

/** Flags of a composite glyph component (OpenType `glyf`). */
const ARG_1_AND_2_ARE_WORDS = 0x0001;

const WE_HAVE_A_SCALE = 0x0008;

const MORE_COMPONENTS = 0x0020;

const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;

const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/** The table checksum: the sum of the big-endian 32-bit words, the last one padded with zeros. */
const checksum = (bytes: Uint8Array) => {
  let sum = 0;

  for (let index = 0; index < bytes.length; index += 4) {
    const word =
      ((bytes[index] ?? 0) << 24) |
      ((bytes[index + 1] ?? 0) << 16) |
      ((bytes[index + 2] ?? 0) << 8) |
      (bytes[index + 3] ?? 0);

    sum = (sum + (word >>> 0)) >>> 0;
  }

  return sum;
};

const padded = (length: number) => (length + 3) & ~3;

/** Assembles a font program from its tables, in tag order, with checksums and the head adjustment. */
const assemble = (tables: Readonly<Record<string, Uint8Array>>) => {
  const entries = Object.entries(tables).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );

  const power = 2 ** Math.floor(Math.log2(entries.length));
  const headerLength = 12 + 16 * entries.length;

  const total = entries.reduce((length, [, table]) => length + padded(table.length), headerLength);

  const program = new Uint8Array(total);
  const view = new DataView(program.buffer);

  view.setUint32(0, 0x00010000);
  view.setUint16(4, entries.length);
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, entries.length * 16 - power * 16);

  let offset = headerLength;
  let headOffset = 0;

  for (const [index, [tag, table]] of entries.entries()) {
    const record = 12 + 16 * index;

    // A table tag is four ASCII characters.
    for (let position = 0; position < 4; position++)
      view.setUint8(record + position, tag.charCodeAt(position));

    view.setUint32(record + 4, checksum(table));
    view.setUint32(record + 8, offset);
    view.setUint32(record + 12, table.length);
    program.set(table, offset);

    if (tag === "head") headOffset = offset;

    offset += padded(table.length);
  }

  // The head table's adjustment makes the whole program sum to the constant of the format.
  view.setUint32(headOffset + 8, (0xb1b0afba - checksum(program)) >>> 0);

  return program;
};

/** Reads one TrueType font program, or fails when a table that the reader needs is unusable. */
export const parseTrueType = (bytes: Uint8Array): Result.Result<TrueTypeFont, TrueTypeMalformed> =>
  Result.gen(function* () {
    const malformed = (reason: string) => Result.fail(new TrueTypeMalformed({ reason }));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length < 12 || view.getUint32(0) !== 0x00010000)
      return yield* malformed("not a TrueType outline font");

    const tableCount = view.getUint16(4);

    if (bytes.length < 12 + 16 * tableCount) return yield* malformed("truncated table directory");

    const directory = new Map<string, Table>();

    for (let index = 0; index < tableCount; index++) {
      const record = 12 + 16 * index;
      const tag = String.fromCharCode(...bytes.subarray(record, record + 4));
      const table = { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) };

      if (table.offset + table.length > bytes.length) return yield* malformed(`truncated ${tag}`);

      directory.set(tag, table);
    }

    const tableOf = (tag: string) => {
      const table = directory.get(tag);

      return table === undefined ? malformed(`no ${tag} table`) : Result.succeed(table);
    };

    const source = {
      os2: yield* tableOf("OS/2"),
      cmap: yield* tableOf("cmap"),
      glyf: yield* tableOf("glyf"),
      head: yield* tableOf("head"),
      hhea: yield* tableOf("hhea"),
      hmtx: yield* tableOf("hmtx"),
      loca: yield* tableOf("loca"),
      maxp: yield* tableOf("maxp"),
      name: yield* tableOf("name"),
      post: yield* tableOf("post"),
    };

    if (
      source.head.length < 54 ||
      source.hhea.length < 36 ||
      source.maxp.length < 6 ||
      source.post.length < 32 ||
      source.os2.length < 78
    )
      return yield* malformed("truncated header table");

    const head = source.head.offset;
    const unitsPerEm = view.getUint16(head + 18);
    const longOffsets = view.getInt16(head + 50) === 1;
    const glyphCount = view.getUint16(source.maxp.offset + 4);
    const metricCount = view.getUint16(source.hhea.offset + 34);
    const { hmtx, loca, glyf } = source;

    if (unitsPerEm === 0) return yield* malformed("no units per em");

    if (metricCount === 0 || metricCount > glyphCount)
      return yield* malformed("horizontal metrics do not match the glyphs");

    if (hmtx.length < 4 * metricCount + 2 * (glyphCount - metricCount))
      return yield* malformed("truncated hmtx");

    if (loca.length < (glyphCount + 1) * (longOffsets ? 4 : 2))
      return yield* malformed("truncated loca");

    const glyphOffset = (glyph: number) =>
      longOffsets
        ? view.getUint32(loca.offset + 4 * glyph)
        : 2 * view.getUint16(loca.offset + 2 * glyph);

    for (let glyph = 0; glyph < glyphCount; glyph++) {
      if (glyphOffset(glyph) > glyphOffset(glyph + 1) || glyphOffset(glyph + 1) > glyf.length)
        return yield* malformed(`glyph ${glyph} lies outside glyf`);
    }

    // The Unicode full-repertoire character map: format 12 of Windows or Unicode platforms.
    const cmap = source.cmap.offset;
    let groups: { readonly offset: number; readonly count: number } | undefined;

    for (let index = 0; index < view.getUint16(cmap + 2); index++) {
      const record = cmap + 4 + 8 * index;
      const platform = view.getUint16(record);
      const encoding = view.getUint16(record + 2);
      const subtable = cmap + view.getUint32(record + 4);

      if (
        ((platform === 3 && encoding === 10) || (platform === 0 && encoding === 4)) &&
        view.getUint16(subtable) === 12
      )
        groups = { offset: subtable + 16, count: view.getUint32(subtable + 12) };
    }

    if (groups === undefined) return yield* malformed("no format 12 character map");

    const { offset: groupOffset, count: groupCount } = groups;

    const glyphOf = (codePoint: number) => {
      let low = 0;
      let high = groupCount - 1;

      while (low <= high) {
        const middle = (low + high) >>> 1;
        const group = groupOffset + 12 * middle;

        if (codePoint < view.getUint32(group)) high = middle - 1;
        else if (codePoint > view.getUint32(group + 4)) low = middle + 1;
        else {
          const glyph = view.getUint32(group + 8) + codePoint - view.getUint32(group);

          return glyph < glyphCount ? glyph : 0;
        }
      }

      return 0;
    };

    const advanceOf = (glyph: number) =>
      view.getUint16(hmtx.offset + 4 * Math.min(glyph, metricCount - 1));

    const leftSideBearingOf = (glyph: number) =>
      glyph < metricCount
        ? view.getInt16(hmtx.offset + 4 * glyph + 2)
        : view.getInt16(hmtx.offset + 4 * metricCount + 2 * (glyph - metricCount));

    const glyphData = (glyph: number) =>
      bytes.subarray(glyf.offset + glyphOffset(glyph), glyf.offset + glyphOffset(glyph + 1));

    /** The offsets of the component glyph indices of a composite glyph; none for a simple glyph. */
    const componentOffsets = (data: Uint8Array) => {
      const glyphView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const offsets: Array<number> = [];

      if (data.length < 10 || glyphView.getInt16(0) >= 0) return offsets;

      let position = 10;
      let flags = MORE_COMPONENTS;

      while ((flags & MORE_COMPONENTS) !== 0 && position + 4 <= data.length) {
        flags = glyphView.getUint16(position);
        offsets.push(position + 2);
        position += 4 + ((flags & ARG_1_AND_2_ARE_WORDS) !== 0 ? 4 : 2);

        if ((flags & WE_HAVE_A_SCALE) !== 0) position += 2;
        else if ((flags & WE_HAVE_AN_X_AND_Y_SCALE) !== 0) position += 4;
        else if ((flags & WE_HAVE_A_TWO_BY_TWO) !== 0) position += 8;
      }

      return offsets;
    };

    const copy = (table: Table, length = table.length) =>
      Uint8Array.from(bytes.subarray(table.offset, table.offset + length));

    const subset = (requested: Iterable<number>): TrueTypeSubset => {
      const order = [0];
      const glyphs = new Map([[0, 0]]);

      const include = (glyph: number) => {
        if (glyph < glyphCount && !glyphs.has(glyph)) {
          glyphs.set(glyph, order.length);
          order.push(glyph);
        }
      };

      for (const glyph of requested) include(glyph);

      // Components join after the glyphs that use them; the loop reaches their components too.
      for (let index = 0; index < order.length; index++) {
        const data = glyphData(order[index] ?? 0);
        const glyphView = new DataView(data.buffer, data.byteOffset, data.byteLength);

        for (const offset of componentOffsets(data)) include(glyphView.getUint16(offset));
      }

      const outlines = order.map((glyph) => {
        const data = Uint8Array.from(glyphData(glyph));
        const glyphView = new DataView(data.buffer);

        for (const offset of componentOffsets(data))
          glyphView.setUint16(offset, glyphs.get(glyphView.getUint16(offset)) ?? 0);

        return data;
      });

      const glyfTable = new Uint8Array(
        outlines.reduce((sum, data) => sum + padded(data.length), 0),
      );

      const locaTable = new Uint8Array(4 * (order.length + 1));
      const hmtxTable = new Uint8Array(4 * order.length);
      const locaView = new DataView(locaTable.buffer);
      const hmtxView = new DataView(hmtxTable.buffer);
      let position = 0;

      for (const [index, data] of outlines.entries()) {
        const glyph = order[index] ?? 0;

        locaView.setUint32(4 * index, position);
        glyfTable.set(data, position);
        position += padded(data.length);
        hmtxView.setUint16(4 * index, advanceOf(glyph));
        hmtxView.setInt16(4 * index + 2, leftSideBearingOf(glyph));
      }

      locaView.setUint32(4 * order.length, position);

      const headTable = copy(source.head);
      const hheaTable = copy(source.hhea);
      const maxpTable = copy(source.maxp);
      const postTable = copy(source.post, 32);

      new DataView(headTable.buffer).setUint32(8, 0);
      new DataView(headTable.buffer).setInt16(50, 1);
      new DataView(hheaTable.buffer).setUint16(34, order.length);
      new DataView(maxpTable.buffer).setUint16(4, order.length);
      // Format 3 names no glyphs.
      new DataView(postTable.buffer).setUint32(0, 0x00030000);

      return {
        glyphs,
        advances: order.map((glyph) => advanceOf(glyph)),
        program: assemble({
          "OS/2": copy(source.os2),
          glyf: glyfTable,
          head: headTable,
          hhea: hheaTable,
          hmtx: hmtxTable,
          loca: locaTable,
          maxp: maxpTable,
          name: copy(source.name),
          post: postTable,
        }),
      };
    };

    // The PostScript name (name ID 6) in the Windows Unicode encoding.
    const name = source.name.offset;
    const storage = name + view.getUint16(name + 4);
    let postScriptName = "";

    for (let index = 0; index < view.getUint16(name + 2); index++) {
      const record = name + 6 + 12 * index;

      if (
        view.getUint16(record) === 3 &&
        view.getUint16(record + 2) === 1 &&
        view.getUint16(record + 6) === 6
      ) {
        const start = storage + view.getUint16(record + 10);
        const units = view.getUint16(record + 8) / 2;

        postScriptName = String.fromCharCode(
          ...Array.from({ length: units }, (_, unit) => view.getUint16(start + 2 * unit)),
        );
      }
    }

    if (!/^[\x21-\x7e]{1,63}$/u.test(postScriptName) || /[[\](){}<>/%]/u.test(postScriptName))
      return yield* malformed("no usable PostScript name");

    const os2 = source.os2.offset;
    const hhea = source.hhea.offset;

    return {
      postScriptName,
      unitsPerEm,
      boundingBox: [
        view.getInt16(head + 36),
        view.getInt16(head + 38),
        view.getInt16(head + 40),
        view.getInt16(head + 42),
      ],
      ascent: view.getInt16(hhea + 4),
      descent: view.getInt16(hhea + 6),
      // Version 2 of OS/2 added the cap height; older fonts state their ascent instead.
      capHeight:
        view.getUint16(os2) >= 2 && source.os2.length >= 90
          ? view.getInt16(os2 + 88)
          : view.getInt16(hhea + 4),
      glyphOf,
      advanceOf,
      subset,
    };
  });

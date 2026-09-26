/**
 * The certificate fonts: the files that their provenance names, every name that they cover
 * printed as text that a reader extracts, and text that no glyph covers refused by field.
 */
import { CertificateIssue } from "@vektorprogrammet/domain/placements";
import { Effect, FileSystem, Layer, Path, Result, Schema } from "effect";
import { expect, layer } from "@effect/vitest";
import { sha256Hex } from "../http-semantics.js";
import { TestPlatform } from "../test/platform.js";
import {
  CertificateFonts,
  CertificateFontsLive,
  CertificateUnprintable,
  renderCertificatePdf,
} from "./certificate-pdf.js";

const Provenance = Schema.Struct({
  files: Schema.Record(Schema.String, Schema.Struct({ sha256: Schema.String })),
});

const issue = (names: { readonly assistant: string; readonly school: string }) =>
  Schema.decodeSync(CertificateIssue)({
    issueId: `certificate-issue-${"a".repeat(64)}`,
    content: {
      personId: "pdf-assistant",
      assistantName: names.assistant,
      departmentId: "pdf-department",
      departmentName: "Ås",
      semesters: [
        {
          semesterId: "pdf-spring",
          startsOn: "2026-01-01",
          endsOn: "2026-08-01",
          schools: [names.school, "Æsøy skole"],
          days: 6,
        },
      ],
    },
    contentSha256: "b".repeat(64),
    issuedAt: "2026-09-26T10:00:00.000Z",
    issuedOn: "2026-09-26",
    issuer: {
      personId: "pdf-issuer",
      name: "Siri Styreleder",
      seatTitle: "Styreleder, Styret",
      basis: "BoardSeat",
    },
  });

/**
 * The text that a reader extracts from a certificate: every shown glyph string, decoded through
 * the ToUnicode map of the font that the page resources name for it.
 */
const extractedText = (pdf: Uint8Array) => {
  const document = new TextDecoder("latin1").decode(pdf);

  const object = (id: string) =>
    new RegExp(`(?:^|\\n)${id} 0 obj\\n([\\s\\S]*?)\\nendobj`, "u").exec(document)?.[1] ?? "";

  const resources = /\/Font << \/F1 (\d+) 0 R \/F2 (\d+) 0 R >>/u.exec(document);

  const maps = Object.fromEntries(
    (["F1", "F2"] as const).map((face, index) => {
      const toUnicode = /\/ToUnicode (\d+) 0 R/u.exec(object(resources?.[index + 1] ?? ""))?.[1];

      const pairs = object(toUnicode ?? "").matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/gu);

      return [
        face,
        new Map(
          [...pairs].map(([, glyph, unicode]) => [
            glyph,
            String.fromCharCode(
              ...(unicode?.match(/.{4}/gu) ?? []).map((unit) => Number.parseInt(unit, 16)),
            ),
          ]),
        ),
      ];
    }),
  );

  return [...document.matchAll(/BT \/(F[12]) [^<]*<([0-9A-F]*)> Tj ET/gu)]
    .map(([, face, glyphs]) =>
      (glyphs?.match(/.{4}/gu) ?? [])
        .map((glyph) => maps[face ?? ""]?.get(glyph) ?? "\uFFFD")
        .join(""),
    )
    .join("\n");
};

layer(CertificateFontsLive.pipe(Layer.provideMerge(TestPlatform)), {
  excludeTestServices: true,
})("certificate PDF", (it) => {
  it.effect("keeps exactly the font files that its provenance names, unchanged", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* path.fromFileUrl(new URL("fonts/", import.meta.url));

      const provenance = yield* Schema.decodeEffect(Schema.fromJsonString(Provenance))(
        yield* fs.readFileString(path.join(directory, "provenance.json")),
      );

      expect((yield* fs.readDirectory(directory)).toSorted()).toEqual(
        [...Object.keys(provenance.files), "provenance.json"].toSorted(),
      );

      for (const [file, { sha256 }] of Object.entries(provenance.files))
        expect(sha256Hex(yield* fs.readFile(path.join(directory, file)))).toBe(sha256);
    }),
  );

  it.effect("prints every name that the embedded fonts cover", () =>
    Effect.gen(function* () {
      const faces = yield* CertificateFonts;
      const certificate = issue({ assistant: "Łukasz Żółć-Øverås", school: "Ιωάννινα σχολείο" });
      const pdf = Result.getOrThrow(renderCertificatePdf(certificate, faces));
      const text = extractedText(pdf);

      expect(text).not.toContain("\uFFFD");
      // A paragraph wraps at spaces, so its lines join with one.
      expect(text.replaceAll("\n", " ")).toContain(
        "Łukasz Żółć-Øverås har vært deltagende i Vektorprogrammet ved Ås som vektorassistent.",
      );
      expect(text).toContain("Ιωάννινα σχολείο, Æsøy skole");
      expect(text).toContain("01.01.2026–01.08.2026");
      expect(text).toContain("Siri Styreleder\nStyreleder, Styret\nUtstedt 26.09.2026");
      // The same issue renders the same bytes.
      expect(Result.getOrThrow(renderCertificatePdf(certificate, faces))).toEqual(pdf);
    }),
  );

  it.effect("refuses text that no embedded glyph covers, naming its field", () =>
    Effect.gen(function* () {
      const faces = yield* CertificateFonts;

      expect(
        renderCertificatePdf(issue({ assistant: "Wei 李", school: "Lade skole" }), faces),
      ).toEqual(Result.fail(new CertificateUnprintable({ field: "assistant" })));
      expect(
        renderCertificatePdf(
          issue({ assistant: "Ada Assistent", school: "Lade\u0007skole" }),
          faces,
        ),
      ).toEqual(Result.fail(new CertificateUnprintable({ field: "school" })));
    }),
  );
});

import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, type Schema } from "effect";
import { decodeOutcomeTemplateDraft, isSafeOutcomeLinkTarget } from "./template.js";

const text = (value: string) => ({ type: "text", text: value });

const placeholder = (name: string) => ({ type: "placeholder", attrs: { name } });

const draftWith = (block: Schema.Json): Schema.Json => ({
  subject: [text("Svar "), placeholder("departmentName"), text(" "), placeholder("semesterName")],
  body: {
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [text("Hei "), placeholder("firstName"), text(" "), placeholder("departmentName")],
      },
      { type: "paragraph", content: [placeholder("semesterName")] },
      block,
    ],
  },
});

const linkDraft = (href: string) =>
  draftWith({
    type: "paragraph",
    content: [{ type: "text", text: "lenke", marks: [{ type: "link", attrs: { href } }] }],
  });

const buttonDraft = (href: string) =>
  draftWith({ type: "button", attrs: { label: "Gå videre", href } });

const accepted = (draft: Schema.Json) =>
  Effect.map(Effect.exit(decodeOutcomeTemplateDraft("Rejected")(draft)), Exit.isSuccess);

/** Targets that a WHATWG parser and a RFC 3986 parser read as different authorities, or that the parser rewrites. */
const ambiguous = [
  "https://evil.example\\@trusted.example/path",
  "https://trusted.example\\.evil.example/",
  "https://evil.example/\\@trusted.example",
  "https://evil.example\\",
  "https://user@trusted.example/",
  "https://user:secret@trusted.example/",
  "https://@trusted.example/",
  "https://Trusted.Example:443/",
  "https://trusted.example:443/",
  "https://tru%73ted.example/",
  "https://tr\u00fcsted.example/",
  "https:///trusted.example/",
  "mailto:ola@example.invalid\\x",
  "https://trusted.example/ path",
  "https://trusted.example/\tpath",
];

const unsafeSchemes = [
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "http://trusted.example/",
  "//trusted.example/",
  "https:/trusted.example/",
  "mailto:",
  "",
];

const valid = [
  "https://trusted.example",
  "https://trusted.example/",
  "https://trusted.example/path?x=1&y=2#frag",
  "https://trusted.example/a/@b",
  "https://trusted.example?next=https://other.example/@x",
  "https://trusted.example:8443/path",
  "mailto:ola@example.invalid",
  "mailto:ola@example.invalid?subject=Svar",
];

describe("outcome template link targets", () => {
  for (const href of valid) {
    it.effect(`accepts ${JSON.stringify(href)} as link and button target`, () =>
      Effect.gen(function* () {
        expect(isSafeOutcomeLinkTarget(href)).toBe(true);
        expect(yield* accepted(linkDraft(href))).toBe(true);
        expect(yield* accepted(buttonDraft(href))).toBe(true);
      }),
    );
  }

  for (const href of [...ambiguous, ...unsafeSchemes]) {
    it.effect(`rejects ${JSON.stringify(href)} as link and button target`, () =>
      Effect.gen(function* () {
        expect(isSafeOutcomeLinkTarget(href)).toBe(false);
        expect(yield* accepted(linkDraft(href))).toBe(false);
        expect(yield* accepted(buttonDraft(href))).toBe(false);
      }),
    );
  }

  it.effect(
    "accepts a draft without a link, so the controls do not pass by an unrelated error",
    () =>
      Effect.gen(function* () {
        expect(
          yield* accepted(draftWith({ type: "paragraph", content: [text("ingen lenke")] })),
        ).toBe(true);
      }),
  );
});

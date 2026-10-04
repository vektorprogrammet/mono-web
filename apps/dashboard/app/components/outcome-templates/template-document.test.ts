import type { OutcomeTemplateSubjectToken } from "@vektorprogrammet/domain/admissions/template";
import { expect, it } from "vitest";
import {
  fromTemplateSubject,
  templateDraftProblems,
  toTemplateBody,
  toTemplateSubject,
} from "./template-document";

const placeholder = (name: string) => ({ type: "placeholder", attrs: { name } });

const text = (value: string) => ({ type: "text", text: value });

const subject = [
  text("Opptaksresultat - "),
  placeholder("departmentName"),
  text(", "),
  placeholder("semesterName"),
];

it("projects the editor tree onto the closed model and drops editor-only attributes", () => {
  const body = toTemplateBody({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Hei ",
            marks: [
              { type: "bold" },
              {
                type: "link",
                attrs: { href: "https://example.com", target: "_blank", rel: "noopener", class: null },
              },
            ],
          },
          placeholder("firstName"),
        ],
      },
      { type: "orderedList", attrs: { start: 1, type: null }, content: [
        { type: "listItem", content: [{ type: "paragraph" }] },
      ] },
      { type: "paragraph" },
    ],
  });

  expect(body).toEqual({
    version: 1,
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Hei ",
            marks: [{ type: "bold" }, { type: "link", attrs: { href: "https://example.com" } }],
          },
          placeholder("firstName"),
        ],
      },
      { type: "orderedList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] },
    ],
  });
});

it("round-trips subject tokens through the one-line subject editor", () => {
  const tokens = [
    { type: "text", text: "Opptaksresultat - " },
    { type: "placeholder", attrs: { name: "departmentName" } },
  ] satisfies ReadonlyArray<OutcomeTemplateSubjectToken>;

  expect(toTemplateSubject(fromTemplateSubject(tokens))).toEqual(tokens);
});

it("accepts a draft that uses exactly the placeholders of its variant", () => {
  const body = toTemplateBody({
    type: "doc",
    content: [{ type: "paragraph", content: [text("Hei "), placeholder("firstName")] }],
  });

  expect(templateDraftProblems("Rejected", { subject, body })).toEqual([]);
});

it("names a missing placeholder instead of sending the draft", () => {
  const body = toTemplateBody({
    type: "doc",
    content: [{ type: "paragraph", content: [text("Hei")] }],
  });

  expect(templateDraftProblems("Rejected", { subject, body }).join(" ")).toContain("firstName");
});

it("does not hide a node outside the closed model: the schema refuses it", () => {
  const body = toTemplateBody({
    type: "doc",
    content: [
      { type: "paragraph", content: [placeholder("firstName")] },
      { type: "html", attrs: { value: "<b>x</b>" } },
    ],
  });

  expect(body.content[1]).toEqual({ type: "html" });
  expect(templateDraftProblems("Rejected", { subject, body })).toHaveLength(1);
});

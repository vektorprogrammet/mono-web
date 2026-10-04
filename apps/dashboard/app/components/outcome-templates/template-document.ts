import type { JSONContent } from "@tiptap/core";
import {
  OutcomeTemplateDraft,
  outcomeTemplatePlaceholders,
  outcomeTemplateUsedPlaceholders,
  type OutcomePlaceholderName,
  type OutcomeTemplateKind,
  type OutcomeTemplateSubjectToken,
} from "@vektorprogrammet/domain/admissions/template";
import { Option, Schema } from "effect";

/**
 * The browser side of the closed outcome-mail document of spec 0027.
 *
 * The editor emits a Tiptap/ProseMirror JSON tree. This module projects that tree onto the closed
 * wire model of `@vektorprogrammet/domain/admissions/template` by an allowlist of node names and
 * attributes, and never serializes editor HTML. A node or mark that the allowlist does not know
 * keeps only its name, so the schema check below and the server's strict decode refuse it instead
 * of the projection hiding it.
 */

/** A document in the wire shape of the closed outcome-mail model, before the server decodes it. */
export interface TemplateBodyJson {
  readonly version: 1;
  readonly type: "doc";
  readonly content: ReadonlyArray<Schema.Json>;
}

// Bold and italic carry no attributes, and an unknown mark keeps only its name: both are `{ type }`.
const projectMark = (mark: NonNullable<JSONContent["marks"]>[number]): Schema.Json =>
  mark.type === "link"
    ? { type: "link", attrs: { href: mark.attrs?.["href"] ?? null } }
    : { type: mark.type };

const withContent = (type: string, content: JSONContent["content"]): Schema.Json =>
  content === undefined || content.length === 0
    ? { type }
    : { type, content: content.map(projectNode) };

function projectNode(node: JSONContent): Schema.Json {
  switch (node.type) {
    case "text": {
      const marks = (node.marks ?? []).map(projectMark);

      return marks.length === 0
        ? { type: "text", text: node.text ?? "" }
        : { type: "text", text: node.text ?? "", marks };
    }

    case "placeholder":
      return { type: "placeholder", attrs: { name: node.attrs?.["name"] ?? null } };
    case "hardBreak":
      return { type: "hardBreak" };
    case "paragraph":
      return withContent("paragraph", node.content);
    case "heading": {
      const heading = { type: "heading", attrs: { level: node.attrs?.["level"] ?? null } };

      return node.content === undefined || node.content.length === 0
        ? heading
        : { ...heading, content: node.content.map(projectNode) };
    }

    case "bulletList":
      return { type: "bulletList", content: (node.content ?? []).map(projectNode) };
    case "orderedList": {
      const start = node.attrs?.["start"];
      const content = (node.content ?? []).map(projectNode);

      return start === undefined || start === null || start === 1
        ? { type: "orderedList", content }
        : { type: "orderedList", attrs: { start }, content };
    }

    case "listItem":
      return { type: "listItem", content: (node.content ?? []).map(projectNode) };
    case "button":
      return {
        type: "button",
        attrs: { label: node.attrs?.["label"] ?? null, href: node.attrs?.["href"] ?? null },
      };
    default:
      return { type: node.type ?? "" };
  }
}

/**
 * The wire body of an editor document: version 1, allowlisted nodes only, and no trailing empty
 * paragraphs that exist only as the editor's cursor landing place.
 */
export const toTemplateBody = (doc: JSONContent): TemplateBodyJson => {
  const blocks = [...(doc.content ?? [])];

  while (blocks.length > 1) {
    const last = blocks[blocks.length - 1];

    if (last?.type !== "paragraph" || (last.content !== undefined && last.content.length > 0)) break;

    blocks.pop();
  }

  return { version: 1, type: "doc", content: blocks.map(projectNode) };
};

/** The editor document of a stored body: the same tree without the wire version. */
export const fromTemplateBody = (body: { readonly content: ReadonlyArray<object> }): JSONContent => ({
  type: "doc",
  // SAFETY: a stored body is a validated closed document, and its nodes are Tiptap JSON nodes of the
  // editor's own schema; only the readonly modifiers of the decoded type differ.
  content: Array.from(body.content) as JSONContent[],
});

/** What an author edits: the subject tokens and the body of one variant, in wire shape. */
export interface TemplateDraft {
  readonly subject: ReadonlyArray<Schema.Json>;
  readonly body: TemplateBodyJson;
}

/** The draft that starts as a stored revision: the stored subject and the projected stored body. */
export const templateDraftOf = (revision: {
  readonly subject: ReadonlyArray<OutcomeTemplateSubjectToken>;
  readonly body: { readonly content: ReadonlyArray<object> };
}): TemplateDraft => ({
  subject: revision.subject,
  body: toTemplateBody(fromTemplateBody(revision.body)),
});

const projectSubjectNode = (node: JSONContent): Schema.Json => {
  switch (node.type) {
    case "text":
      return { type: "text", text: node.text ?? "" };
    case "placeholder":
      return { type: "placeholder", attrs: { name: node.attrs?.["name"] ?? null } };
    default:
      return { type: node.type ?? "" };
  }
};

/** The wire subject of the one-paragraph subject editor: text and placeholder tokens. */
export const toTemplateSubject = (doc: JSONContent): ReadonlyArray<Schema.Json> =>
  (doc.content?.[0]?.content ?? []).map(projectSubjectNode);

/** The subject editor document of stored subject tokens. */
export const fromTemplateSubject = (
  tokens: ReadonlyArray<OutcomeTemplateSubjectToken>,
): JSONContent => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: tokens.map((token) =>
        token.type === "text"
          ? { type: "text", text: token.text }
          : { type: "placeholder", attrs: { name: token.attrs.name } },
      ),
    },
  ],
});

/** Norwegian names of the approved placeholder tokens. */
export const placeholderLabels: Readonly<Record<OutcomePlaceholderName, string>> = {
  firstName: "Fornavn",
  departmentName: "Avdeling",
  semesterName: "Semester",
  schoolName: "Skole",
};

export const outcomeTemplateKindLabels: Readonly<Record<OutcomeTemplateKind, string>> = {
  AdmittedWithSchool: "Tatt opp, med skoleplassering",
  AdmittedPlacementPending: "Tatt opp, skoleplassering kommer",
  Rejected: "Avslag",
};

/**
 * A client-side check before preview and save, with the schema of the server's strict decode. It
 * spares a round trip and explains the usual mistakes; the server decides independently.
 */
export const templateDraftProblems = (
  kind: OutcomeTemplateKind,
  draft: { readonly subject: ReadonlyArray<Schema.Json>; readonly body: TemplateBodyJson },
): ReadonlyArray<string> => {
  const decoded = Schema.decodeUnknownOption(OutcomeTemplateDraft, { onExcessProperty: "error" })(
    draft,
  );

  if (Option.isNone(decoded))
    return [
      draft.subject.length === 0
        ? "Emnet kan ikke være tomt."
        : "Malen inneholder innhold som ikke er tillatt, eller en ugyldig lenke.",
    ];

  const allowed = outcomeTemplatePlaceholders(kind);
  const used = Array.from(new Set(outcomeTemplateUsedPlaceholders(decoded.value)));

  return [
    ...allowed
      .filter((name) => !used.includes(name))
      .map(
        (name) => `Malen må bruke «${placeholderLabels[name]}» (${name}) i emnet eller teksten.`,
      ),
    ...used
      .filter((name) => !allowed.includes(name))
      .map((name) => `«${placeholderLabels[name]}» (${name}) kan ikke brukes i denne varianten.`),
  ];
};

/**
 * The code-owned renderer of the admission outcome mail (spec 0027).
 *
 * A pure visitor maps only the validated nodes of a closed template document to React Email
 * elements inside one fixed `<Html>/<Body>/<Container>` layout. Placeholder values are React text
 * children, so React escapes them; nothing an author writes is HTML, MDX, JSX or a component name.
 * `render` of the element is the HTML and `toPlainText` of that HTML is the text alternative.
 * Preview and announce call this one renderer, so a preview shows exactly the bytes that the
 * announcement queues.
 */
import { Effect } from "effect";
import * as React from "react";
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Text,
  render,
  toPlainText,
} from "react-email";
import {
  decodeOutcomeMailValues,
  decodeOutcomeTemplateDraft,
  outcomeTemplateUsesExactPlaceholders,
  OutcomeMailRenderFailure,
  type OutcomeMailRenderer,
  type OutcomeMailValues,
  type OutcomeTemplateBlock,
  type OutcomeTemplateDraft,
  type OutcomeTemplateFailure,
  type OutcomeTemplateInline,
  type OutcomeTemplateKind,
  type RenderedOutcomeMail,
} from "@vektorprogrammet/domain/admissions/template";

const fontFamily =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const bodyStyle = { backgroundColor: "#ffffff", fontFamily, margin: "0", padding: "0" };

const containerStyle = { maxWidth: "600px", margin: "0 auto", padding: "24px 16px" };

const textStyle = { fontSize: "16px", lineHeight: "24px", margin: "0 0 16px", color: "#111111" };

const headingStyle = { fontFamily, margin: "0 0 16px", color: "#111111" };

const listStyle = { fontSize: "16px", lineHeight: "24px", margin: "0 0 16px", paddingLeft: "24px" };

const buttonStyle = {
  backgroundColor: "#111111",
  color: "#ffffff",
  borderRadius: "4px",
  padding: "12px 20px",
  fontSize: "16px",
  textDecoration: "none",
  display: "inline-block",
  margin: "0 0 16px",
};

const CONTROL_RUNS = /\p{Cc}+/gu;

type Mark = NonNullable<Extract<OutcomeTemplateInline, { readonly type: "text" }>["marks"]>[number];

/** Wraps text in the elements of its marks; the link is outermost. */
const withMarks = (text: string, marks: ReadonlyArray<Mark>): React.ReactNode => {
  const bold = marks.some((mark) => mark.type === "bold");
  const italic = marks.some((mark) => mark.type === "italic");
  const link = marks.find((mark) => mark.type === "link");

  const strong = bold ? React.createElement("strong", null, text) : text;
  const emphasised = italic ? React.createElement("em", null, strong) : strong;

  return link === undefined
    ? emphasised
    : React.createElement(Link, { href: link.attrs.href }, emphasised);
};

/**
 * The children of one paragraph-like node. Adjacent unmarked text and placeholders merge into one
 * string, so the HTML has no comment markers between them.
 */
const inline = (
  nodes: ReadonlyArray<OutcomeTemplateInline> | undefined,
  values: OutcomeMailValues,
): ReadonlyArray<React.ReactNode> => {
  const children: Array<React.ReactNode> = [];
  let run = "";

  const flush = () => {
    if (run === "") return;

    children.push(run);
    run = "";
  };

  for (const node of nodes ?? []) {
    switch (node.type) {
      case "placeholder":
        run += values[node.attrs.name] ?? "";
        break;
      case "hardBreak":
        flush();
        children.push(React.createElement("br"));
        break;
      case "text":
        if (node.marks === undefined || node.marks.length === 0) {
          run += node.text;
        } else {
          flush();
          children.push(withMarks(node.text, node.marks));
        }

        break;
    }
  }

  flush();

  return children;
};

const listItems = (
  items: ReadonlyArray<{
    readonly content: ReadonlyArray<{ readonly content?: ReadonlyArray<OutcomeTemplateInline> }>;
  }>,
  values: OutcomeMailValues,
): ReadonlyArray<React.ReactNode> =>
  items.map((item) =>
    React.createElement(
      "li",
      null,
      ...item.content.flatMap((paragraph, index) => [
        ...(index === 0 ? [] : [React.createElement("br")]),
        ...inline(paragraph.content, values),
      ]),
    ),
  );

/** The pure visitor: one validated block node to one React Email element. */
const block = (node: OutcomeTemplateBlock, values: OutcomeMailValues): React.ReactNode => {
  switch (node.type) {
    case "paragraph":
      return React.createElement(Text, { style: textStyle }, ...inline(node.content, values));
    case "heading":
      return React.createElement(
        Heading,
        { as: `h${node.attrs.level}` as const, style: headingStyle },
        ...inline(node.content, values),
      );
    case "bulletList":
      return React.createElement("ul", { style: listStyle }, ...listItems(node.content, values));
    case "orderedList":
      return React.createElement(
        "ol",
        { style: listStyle, start: node.attrs?.start },
        ...listItems(node.content, values),
      );
    case "button":
      return React.createElement(
        Button,
        { href: node.attrs.href, style: buttonStyle },
        node.attrs.label,
      );
  }
};

/** The fixed layout around the visited document. */
const layout = (template: OutcomeTemplateDraft, values: OutcomeMailValues): React.ReactElement =>
  React.createElement(
    Html,
    { lang: "nb" },
    React.createElement(Head),
    React.createElement(
      Body,
      { style: bodyStyle },
      React.createElement(
        Container,
        { style: containerStyle },
        ...template.body.content.map((node) => block(node, values)),
      ),
    ),
  );

/** The subject: tokens joined with their values, control characters folded into single spaces. */
const subjectOf = (template: OutcomeTemplateDraft, values: OutcomeMailValues): string =>
  template.subject
    .map((token) => (token.type === "text" ? token.text : (values[token.attrs.name] ?? "")))
    .join("")
    .replace(CONTROL_RUNS, " ")
    .trim();

const headingSelectors = (["h1", "h2", "h3"] as const).map((selector) => ({
  selector,
  options: { uppercase: false },
}));

/**
 * Renders one validated template into `{subject, html, text}`.
 *
 * @remarks
 * The template must use exactly the placeholders of `kind` and `values` must be the values of
 * `kind` (`schoolName` only for `AdmittedWithSchool`); otherwise it fails with
 * `OutcomeMailRenderFailure`. The only I/O is React's rendering of the element.
 */
export const renderOutcomeMail: OutcomeMailRenderer<OutcomeMailRenderFailure> = ({
  kind,
  template,
  values,
}) =>
  Effect.gen(function* () {
    const checked = yield* decodeOutcomeMailValues(kind)(values).pipe(
      Effect.mapError((cause) => new OutcomeMailRenderFailure({ cause })),
    );

    if (!outcomeTemplateUsesExactPlaceholders(kind, template))
      return yield* new OutcomeMailRenderFailure({ cause: "placeholders" });

    const subject = subjectOf(template, checked);

    if (subject.length === 0) return yield* new OutcomeMailRenderFailure({ cause: "subject" });

    const html = yield* Effect.tryPromise({
      try: () => render(layout(template, checked)),
      catch: (cause) => new OutcomeMailRenderFailure({ cause }),
    });

    const text = yield* Effect.try({
      try: () => toPlainText(html, { selectors: headingSelectors }),
      catch: (cause) => new OutcomeMailRenderFailure({ cause }),
    });

    return { subject, html, text } satisfies RenderedOutcomeMail;
  });

/**
 * Preview of a proposed draft: the same strict decode as save and the same renderer as announce,
 * with explicit sample values and no write. Fails with `OutcomeTemplateFailure` (422) for an unsafe
 * or unbalanced draft or sample.
 */
export const previewOutcomeTemplate = (input: {
  readonly kind: OutcomeTemplateKind;
  readonly draft: unknown;
  readonly sample: unknown;
}): Effect.Effect<RenderedOutcomeMail, OutcomeTemplateFailure | OutcomeMailRenderFailure> =>
  Effect.gen(function* () {
    const template = yield* decodeOutcomeTemplateDraft(input.kind)(input.draft);
    const values = yield* decodeOutcomeMailValues(input.kind)(input.sample);

    return yield* renderOutcomeMail({ kind: input.kind, template, values });
  });

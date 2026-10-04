import { Data, Effect, flow, Schema } from "effect";
import { DelegationArea } from "../authz/delegation.js";
import { delegationsReaching, ReachScope, ReachTarget, scopeCovers } from "../authz/reach.js";
import type { OrganizationPersonAuthority } from "../organization/authority.js";
import { DepartmentId } from "../organization/schema.js";
import { Rfc3339InstantSchema } from "../time.js";

/**
 * The editable mail of an admission outcome (spec 0027): three variants of two outcomes, each a
 * subject of text and placeholder tokens and a closed, versioned, ProseMirror-compatible JSON
 * document. Nothing here is HTML, MDX, JSX or a component name: the document is data, and only a
 * code-owned renderer turns its validated nodes into a message.
 *
 * Schema decoding ignores excess keys unless asked otherwise, so every boundary decodes with
 * `decodeOutcomeTemplateDraft` and `decodeOutcomeMailValues`, which reject them.
 */

/** The three variants of the two outcomes `Admitted` and `Rejected`. */
export const OutcomeTemplateKind = Schema.Literals([
  "AdmittedWithSchool",
  "AdmittedPlacementPending",
  "Rejected",
]);

export type OutcomeTemplateKind = typeof OutcomeTemplateKind.Type;

export const outcomeTemplateKinds: ReadonlyArray<OutcomeTemplateKind> =
  OutcomeTemplateKind.literals;

/** The atomic tokens an author may place; the recipient's email is never one of them. */
export const OutcomePlaceholderName = Schema.Literals([
  "firstName",
  "departmentName",
  "semesterName",
  "schoolName",
]);

export type OutcomePlaceholderName = typeof OutcomePlaceholderName.Type;

/**
 * The placeholders of one variant. Subject and body together must use every one of them and no
 * other: `schoolName` exists only for an admitted person with an active placement.
 */
export const outcomeTemplatePlaceholders = (
  kind: OutcomeTemplateKind,
): ReadonlyArray<OutcomePlaceholderName> =>
  kind === "AdmittedWithSchool"
    ? ["firstName", "departmentName", "semesterName", "schoolName"]
    : ["firstName", "departmentName", "semesterName"];

const CONTROL_CHARACTERS = /\p{Cc}/u;

const LINK_SCHEME = /^(?:https:\/\/|mailto:)/iu;

/** An `https:` or `mailto:` target without whitespace, control characters or credentials. */
export const isSafeOutcomeLinkTarget = (value: string): boolean => {
  if (
    value.length === 0 ||
    value.length > 2048 ||
    CONTROL_CHARACTERS.test(value) ||
    /\s/u.test(value) ||
    !LINK_SCHEME.test(value) ||
    !URL.canParse(value)
  )
    return false;

  const url = new URL(value);

  return url.protocol === "mailto:"
    ? url.pathname.length > 0
    : url.protocol === "https:" &&
        url.hostname.length > 0 &&
        url.username.length === 0 &&
        url.password.length === 0;
};

const LinkTarget = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(isSafeOutcomeLinkTarget, { message: "an https: or mailto: link" }),
  ),
);

const TextContent = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1), Schema.isMaxLength(5000)),
);

const PlaceholderNode = Schema.Struct({
  type: Schema.Literal("placeholder"),
  attrs: Schema.Struct({ name: OutcomePlaceholderName }),
});

const BoldMark = Schema.Struct({ type: Schema.Literal("bold") });

const ItalicMark = Schema.Struct({ type: Schema.Literal("italic") });

const LinkMark = Schema.Struct({
  type: Schema.Literal("link"),
  attrs: Schema.Struct({ href: LinkTarget }),
});

const Mark = Schema.Union([BoldMark, ItalicMark, LinkMark]);

const TextNode = Schema.Struct({
  type: Schema.Literal("text"),
  text: TextContent,
  marks: Schema.optionalKey(
    Schema.Array(Mark).pipe(
      Schema.check(
        Schema.isMaxLength(3),
        Schema.makeFilter(
          (marks) => new Set(marks.map((mark) => mark.type)).size === marks.length,
          {
            message: "each mark at most once",
          },
        ),
      ),
    ),
  ),
});

const HardBreakNode = Schema.Struct({ type: Schema.Literal("hardBreak") });

const InlineNode = Schema.Union([TextNode, PlaceholderNode, HardBreakNode]);

const InlineContent = Schema.Array(InlineNode).pipe(Schema.check(Schema.isMaxLength(200)));

const ParagraphNode = Schema.Struct({
  type: Schema.Literal("paragraph"),
  content: Schema.optionalKey(InlineContent),
});

const HeadingNode = Schema.Struct({
  type: Schema.Literal("heading"),
  attrs: Schema.Struct({ level: Schema.Literals([1, 2, 3]) }),
  content: Schema.optionalKey(InlineContent),
});

const ListItemNode = Schema.Struct({
  type: Schema.Literal("listItem"),
  content: Schema.NonEmptyArray(ParagraphNode),
});

const ListItems = Schema.NonEmptyArray(ListItemNode).pipe(Schema.check(Schema.isMaxLength(50)));

const BulletListNode = Schema.Struct({
  type: Schema.Literal("bulletList"),
  content: ListItems,
});

const OrderedListNode = Schema.Struct({
  type: Schema.Literal("orderedList"),
  attrs: Schema.optionalKey(
    Schema.Struct({
      start: Schema.optionalKey(
        Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 }))),
      ),
    }),
  ),
  content: ListItems,
});

/** The one allowlisted action node: a labelled button whose target is an https: or mailto: link. */
const ButtonNode = Schema.Struct({
  type: Schema.Literal("button"),
  attrs: Schema.Struct({
    label: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(80))),
    href: LinkTarget,
  }),
});

const BlockNode = Schema.Union([
  ParagraphNode,
  HeadingNode,
  BulletListNode,
  OrderedListNode,
  ButtonNode,
]);

export const OutcomeTemplateDocument = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("doc"),
  content: Schema.NonEmptyArray(BlockNode).pipe(Schema.check(Schema.isMaxLength(100))),
});

export type OutcomeTemplateDocument = typeof OutcomeTemplateDocument.Type;

/** A subject token is plain text or a placeholder; a subject has no marks, breaks or blocks. */
export const OutcomeTemplateSubjectToken = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    text: TextContent.pipe(
      Schema.check(
        Schema.makeFilter((value) => !CONTROL_CHARACTERS.test(value), {
          message: "no control characters in a subject",
        }),
      ),
    ),
  }),
  PlaceholderNode,
]);

export type OutcomeTemplateSubjectToken = typeof OutcomeTemplateSubjectToken.Type;

export const OutcomeTemplateDraft = Schema.Struct({
  subject: Schema.NonEmptyArray(OutcomeTemplateSubjectToken).pipe(
    Schema.check(Schema.isMaxLength(50)),
  ),
  body: OutcomeTemplateDocument,
});

export type OutcomeTemplateDraft = typeof OutcomeTemplateDraft.Type;

/** An inline node of a document, for the code-owned renderer's visitor. */
export type OutcomeTemplateInline = typeof InlineNode.Type;

/** A block node of a document, for the code-owned renderer's visitor. */
export type OutcomeTemplateBlock = typeof BlockNode.Type;

type Inline = OutcomeTemplateInline;

type Block = OutcomeTemplateBlock;

const inlinePlaceholders = (nodes: ReadonlyArray<Inline> | undefined) =>
  (nodes ?? []).flatMap((node) => (node.type === "placeholder" ? [node.attrs.name] : []));

const blockPlaceholders = (block: Block): ReadonlyArray<OutcomePlaceholderName> => {
  switch (block.type) {
    case "paragraph":
    case "heading":
      return inlinePlaceholders(block.content);
    case "bulletList":
    case "orderedList":
      return block.content.flatMap((item) =>
        item.content.flatMap((paragraph) => inlinePlaceholders(paragraph.content)),
      );
    case "button":
      return [];
  }
};

/** Every placeholder of subject and body, in document order, repeats included. */
export const outcomeTemplateUsedPlaceholders = (
  draft: OutcomeTemplateDraft,
): ReadonlyArray<OutcomePlaceholderName> => [
  ...draft.subject.flatMap((token) => (token.type === "placeholder" ? [token.attrs.name] : [])),
  ...draft.body.content.flatMap(blockPlaceholders),
];

/** True when subject and body together use exactly the placeholders of `kind`. */
export const outcomeTemplateUsesExactPlaceholders = (
  kind: OutcomeTemplateKind,
  draft: OutcomeTemplateDraft,
): boolean => {
  const used = new Set(outcomeTemplateUsedPlaceholders(draft));
  const expected = outcomeTemplatePlaceholders(kind);

  return used.size === expected.length && expected.every((name) => used.has(name));
};

/** The structure plus the per-variant placeholder set: unknown, missing and wrong-variant fail. */
export const OutcomeTemplateDraftFor = (kind: OutcomeTemplateKind) =>
  OutcomeTemplateDraft.pipe(
    Schema.check(
      Schema.makeFilter((draft) => outcomeTemplateUsesExactPlaceholders(kind, draft), {
        message: `exactly the placeholders of ${kind}`,
      }),
    ),
  );

const strict = { onExcessProperty: "error" } as const;

/** An author's draft is refused, or a scope names no department. */
export class OutcomeTemplateFailure extends Data.TaggedError("OutcomeTemplateFailure")<{
  readonly code: "admission-outcome.template-invalid" | "scope.invalid" | "resource.not-found";
  readonly status: 404 | 422;
}> {}

/** Internal cause information must not enter a public response. */
export class OutcomeTemplatePersistenceError extends Data.TaggedError(
  "OutcomeTemplatePersistenceError",
)<{
  readonly code: "internal.error" | "transaction.conflict";
  readonly status: 409 | 500;
  readonly cause: unknown;
}> {}

/** The template could not be rendered into a message; stored templates were validated on save. */
export class OutcomeMailRenderFailure extends Data.TaggedError("OutcomeMailRenderFailure")<{
  readonly cause: unknown;
}> {}

const invalid = () =>
  new OutcomeTemplateFailure({ code: "admission-outcome.template-invalid", status: 422 });

/**
 * Decodes an untrusted draft once, rejecting excess keys, unknown nodes, marks and protocols, and
 * a placeholder set that differs from the variant's. Fails on save and preview, never at send.
 */
export const decodeOutcomeTemplateDraft = (kind: OutcomeTemplateKind) =>
  flow(Schema.decodeUnknownEffect(OutcomeTemplateDraftFor(kind), strict), Effect.mapError(invalid));

const Value = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
    Schema.makeFilter((value) => !CONTROL_CHARACTERS.test(value), {
      message: "no control characters",
    }),
  ),
);

/** The values that fill the placeholders of one message; the recipient is not among them. */
export const OutcomeMailValues = Schema.Struct({
  firstName: Value,
  departmentName: Value,
  semesterName: Value,
  schoolName: Schema.optionalKey(Value),
});

export type OutcomeMailValues = typeof OutcomeMailValues.Type;

/** The values of `kind`: `schoolName` is present exactly for `AdmittedWithSchool`. */
export const decodeOutcomeMailValues = (kind: OutcomeTemplateKind) =>
  flow(
    Schema.decodeUnknownEffect(
      OutcomeMailValues.pipe(
        Schema.check(
          Schema.makeFilter(
            (values) => (values.schoolName !== undefined) === (kind === "AdmittedWithSchool"),
            { message: "schoolName exactly for AdmittedWithSchool" },
          ),
        ),
      ),
      strict,
    ),
    Effect.mapError(invalid),
  );

/** The exact bytes of one message: the subject, the HTML and its plain text alternative. */
export const RenderedOutcomeMail = Schema.Struct({
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
});

export type RenderedOutcomeMail = typeof RenderedOutcomeMail.Type;

export interface OutcomeMailRenderInput {
  readonly kind: OutcomeTemplateKind;
  readonly template: OutcomeTemplateDraft;
  readonly values: OutcomeMailValues;
}

/**
 * Turns a validated template and its values into one message. Preview and announce pass the same
 * callback, so a preview shows exactly the bytes that a later announcement queues.
 */
export type OutcomeMailRenderer<E = never, R = never> = (
  input: OutcomeMailRenderInput,
) => Effect.Effect<RenderedOutcomeMail, E, R>;

/** The immutable envelope of the `payload_json` of one queued message; the worker adds the sender. */
export const OutcomeMailEnvelope = Schema.Struct({
  deliveryId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  recipient: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  subject: Schema.String,
  html: Schema.String,
  text: Schema.String,
});

export type OutcomeMailEnvelope = typeof OutcomeMailEnvelope.Type;

export const decodeOutcomeMailEnvelope = Schema.decodeUnknownEffect(OutcomeMailEnvelope, strict);

export const OutcomeTemplateProvenance = Schema.Literals(["Global", "Department"]);

export type OutcomeTemplateProvenance = typeof OutcomeTemplateProvenance.Type;

/** One variant's effective revision, with the scope that it came from. */
export const OutcomeTemplateEntry = Schema.Struct({
  kind: OutcomeTemplateKind,
  provenance: OutcomeTemplateProvenance,
  revisionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  revision: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  subject: OutcomeTemplateDraft.fields.subject,
  body: OutcomeTemplateDocument,
  authoredAt: Rfc3339InstantSchema,
});

export type OutcomeTemplateEntry = typeof OutcomeTemplateEntry.Type;

/**
 * The effective templates of one scope: `departmentId` null is the global default set; a
 * department's set shows its own override per variant and the global default for the rest.
 */
export const OutcomeTemplateSet = Schema.Struct({
  departmentId: Schema.NullOr(DepartmentId),
  templates: Schema.Array(OutcomeTemplateEntry),
});

export type OutcomeTemplateSet = typeof OutcomeTemplateSet.Type;

/** What one person may do with the templates of one scope. */
export interface OutcomeTemplateAuthority {
  readonly read: boolean;
  readonly edit: boolean;
}

/**
 * Who may read and edit one scope's templates. Only an active global administrator edits the
 * global default. Only a current explicit `placements.coordinate` delegation of Skolekoordinering
 * that reaches the department edits its override; a global administrator may read it. A board
 * leadership without that delegation, membership and Rekruttering's `admissions.outcomes` confer
 * neither. `delegationsReaching` and `scopeCovers` are the canonical reach.
 */
export const outcomeTemplateAuthority = (
  authority: OrganizationPersonAuthority,
  departmentId?: DepartmentId,
): OutcomeTemplateAuthority => {
  const administrator = authority.globalAdministrator === "Active";

  if (departmentId === undefined) return { read: administrator, edit: administrator };

  const delegated = delegationsReaching(authority, "placements.coordinate").some((delegation) =>
    scopeCovers(
      DelegationArea.guards.Department(delegation.area)
        ? ReachScope.Department({ departmentId: delegation.area.departmentId })
        : ReachScope.Organization(),
      ReachTarget.Department({ departmentId }),
    ),
  );

  return { read: delegated || administrator, edit: delegated };
};

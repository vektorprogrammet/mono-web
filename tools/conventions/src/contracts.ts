/**
 * The contract of a top-level declaration, read from its JSDoc and its type annotations.
 *
 * The JSDoc opens with a summary sentence. Its block tags hold what the types cannot say:
 * `@remarks` how the declaration works, `@sideEffects` what it writes, locks, reads, or waits for,
 * or `none`, `@example` one call as a consumer writes it, and `@avoid` the misuse that it prevents
 * and what to do instead. The optional `@throws` names a failure that the types do not carry.
 * The signature is the parameter and return type annotations as written, and the errors and
 * requirements are split out of the Effect, Stream, Layer, Result, or Option that it returns.
 *
 * Every function here takes any top-level declaration. What is particular to a shared construct,
 * its category and its consumers, lives in `constructs.ts`.
 */
import { parseSync, type ESTree, type ParseResult } from "rolldown/utils";

// Rolldown exports the parse result but not its comment type.
export type Comment = ParseResult["comments"][number];

/** JSDoc lines without the leading `*`. */
export const docLines = (comment: Comment): ReadonlyArray<string> =>
  comment.value.split("\n").map((line) => line.replace(/^\s*\*? ?/u, "").trimEnd());

/** The error and requirement channels of a type; `undefined` where it declares none. */
export interface Channels {
  readonly errors: string | undefined;
  readonly requirements: string | undefined;
}

/** A declaration as its annotations write it. */
export interface Signature extends Channels {
  /** The declaration as a consumer calls or names it, such as `f<A>(value: A): string`. */
  readonly text: string;
  /** The parameters, each as written with its annotation, or the type parameters of a type. */
  readonly inputs: ReadonlyArray<string>;
  /** The return type of a function, the type of a value, or the type that a type alias names. */
  readonly output: string | undefined;
  /** A finding for each annotation that the declaration leaves out. */
  readonly unannotated: ReadonlyArray<string>;
}

export interface Declaration {
  /** The local name, or `default` for an anonymous default export. */
  readonly local: string;
  /** A function declaration, or a variable whose initializer is a function. */
  readonly callable: boolean;
  readonly line: number;
  /** The JSDoc lines without their leading `*`. */
  readonly doc: ReadonlyArray<string>;
  readonly signature: Signature;
}

/** A block comment that is no declaration's JSDoc. */
export interface Unattached {
  readonly line: number;
  readonly doc: ReadonlyArray<string>;
}

export interface ModuleDeclarations {
  readonly declarations: ReadonlyArray<Declaration>;
  readonly unattached: ReadonlyArray<Unattached>;
}

// ---------------------------------------------------------------------------------------------
// Types as written

/** A signature on one line, unless its parameters make it longer than this. */
const lineWidth = 100;

/** Type text on one line: whitespace collapsed, and no padding or trailing comma inside brackets. */
const collapse = (text: string): string =>
  text
    .replace(/\s+/gu, " ")
    .replace(/([([<]) /gu, "$1")
    .replace(/,? ?([)\]>])/gu, "$1")
    .replace(/[;,] \}/gu, " }")
    .trim();

const code = (text: string) => `\`${text}\``;

const none: Channels = { errors: undefined, requirements: undefined };

const typeName = (name: ESTree.TSTypeName): string => {
  switch (name.type) {
    case "Identifier":
      return name.name;
    case "TSQualifiedName":
      return `${typeName(name.left)}.${name.right.name}`;
    case "ThisExpression":
      return "this";
  }
};

/**
 * The channels of a type as written: `E` and `R` of an `Effect` or `Stream`, `E` and `RIn` of a
 * `Layer`, the failure of a `Result`, and the `None` of an `Option`. A namespace prefix, such as
 * `Effect.Effect`, is optional. `never` and an omitted argument declare none, and so does any
 * other type.
 */
export const channelsOf = (type: string): Channels => {
  const source = `type Channels = ${type};\n`;
  const [statement] = parseSync("channels.ts", source).program.body;

  if (
    statement?.type !== "TSTypeAliasDeclaration" ||
    statement.typeAnnotation.type !== "TSTypeReference"
  )
    return none;

  const name = typeName(statement.typeAnnotation.typeName);
  const kind = name.slice(name.lastIndexOf(".") + 1);
  const parameters = statement.typeAnnotation.typeArguments?.params ?? [];

  const argument = (index: number): string | undefined => {
    const node = parameters[index];

    return node === undefined || node.type === "TSNeverKeyword"
      ? undefined
      : collapse(source.slice(node.start, node.end));
  };

  switch (kind) {
    case "Effect":
    case "Stream":
    case "Layer":
      return { errors: argument(1), requirements: argument(2) };
    case "Result":
      return { errors: argument(1), requirements: undefined };
    case "Option":
      return {
        errors: `${name.slice(0, -kind.length)}None<${argument(0) ?? "never"}>`,
        requirements: undefined,
      };
    default:
      return none;
  }
};

/** The text of a node as written, without its comments, on one line. */
type Inline = (node: ESTree.Span) => string;

const inlineOf =
  (text: string, comments: ReadonlyArray<Comment>): Inline =>
  (node) => {
    let written = "";
    let at = node.start;

    for (const comment of comments) {
      if (comment.start < at || comment.end > node.end) continue;

      written += text.slice(at, comment.start);
      at = comment.end;
    }

    return collapse(written + text.slice(at, node.end));
  };

const parameterName = (parameter: ESTree.ParamPattern, inline: Inline): string => {
  switch (parameter.type) {
    case "Identifier":
      return parameter.name;
    case "AssignmentPattern":
      return parameterName(parameter.left, inline);
    case "RestElement":
      return parameterName(parameter.argument, inline);
    case "TSParameterProperty":
      return parameterName(parameter.parameter, inline);
    default:
      return inline(parameter);
  }
};

const annotated = (parameter: ESTree.ParamPattern): boolean => {
  switch (parameter.type) {
    case "AssignmentPattern":
      return annotated(parameter.left);
    case "RestElement":
      return parameter.typeAnnotation != null || annotated(parameter.argument);
    case "TSParameterProperty":
      return annotated(parameter.parameter);
    default:
      return parameter.typeAnnotation != null;
  }
};

interface FunctionLike {
  readonly typeParameters?: ESTree.TSTypeParameterDeclaration | null;
  readonly params: ReadonlyArray<ESTree.ParamPattern>;
  readonly returnType?: ESTree.TSTypeAnnotation | null;
}

const callText = (
  name: string,
  typeParameters: string,
  inputs: ReadonlyArray<string>,
  output: string | undefined,
): string => {
  const returns = output === undefined ? "" : `: ${output}`;
  const flat = `${name}${typeParameters}(${inputs.join(", ")})${returns}`;

  return flat.length <= lineWidth || inputs.length === 0
    ? flat
    : `${name}${typeParameters}(\n${inputs.map((input) => `  ${input}`).join(",\n")}\n)${returns}`;
};

const functionSignature = (
  name: string,
  node: FunctionLike,
  inline: Inline,
  returns: "returns" | "constructs" = "returns",
): Signature => {
  const typeParameters = node.typeParameters == null ? "" : inline(node.typeParameters);
  const inputs = node.params.map((parameter) => inline(parameter));
  const output = node.returnType == null ? undefined : inline(node.returnType.typeAnnotation);

  return {
    text: callText(name, typeParameters, inputs, output),
    inputs,
    output,
    ...(output === undefined ? none : channelsOf(output)),
    unannotated: [
      ...node.params.flatMap((parameter) =>
        annotated(parameter)
          ? []
          : [`has no type annotation on the parameter ${code(parameterName(parameter, inline))}`],
      ),
      ...(output === undefined && returns === "returns" ? ["has no return type annotation"] : []),
    ],
  };
};

const valueSignature = (
  head: string,
  annotation: ESTree.TSType | undefined,
  inline: Inline,
): Signature => {
  const output = annotation === undefined ? undefined : inline(annotation);

  return {
    text: output === undefined ? head : `${head}: ${output}`,
    inputs: [],
    output,
    ...(output === undefined ? none : channelsOf(output)),
    unannotated: output === undefined ? ["has no type annotation"] : [],
  };
};

/** A type declaration: its type parameters are its inputs, and it declares no channels. */
const typeSignature = (
  text: string,
  typeParameters: ESTree.TSTypeParameterDeclaration | null | undefined,
  output: string,
  inline: Inline,
): Signature => ({
  text,
  inputs: (typeParameters?.params ?? []).map((parameter) => inline(parameter)),
  output,
  ...none,
  unannotated: [],
});

const typeArguments = (
  name: string,
  typeParameters: ESTree.TSTypeParameterDeclaration | null | undefined,
): string =>
  typeParameters == null || typeParameters.params.length === 0
    ? name
    : `${name}<${typeParameters.params.map((parameter) => parameter.name.name).join(", ")}>`;

const unwrap = (expression: ESTree.Expression | null): ESTree.Expression | null => {
  switch (expression?.type) {
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "ParenthesizedExpression":
      return unwrap(expression.expression);
    default:
      return expression ?? null;
  }
};

const isFunction = (expression: ESTree.Expression | null): boolean => {
  const inner = unwrap(expression);

  return inner?.type === "ArrowFunctionExpression" || inner?.type === "FunctionExpression";
};

const variableSignature = (
  keyword: string,
  name: string,
  declarator: ESTree.VariableDeclarator,
  inline: Inline,
): Signature => {
  const annotation = declarator.id.typeAnnotation?.typeAnnotation;
  const init = unwrap(declarator.init);

  if (annotation?.type === "TSFunctionType") return functionSignature(name, annotation, inline);

  if (
    annotation === undefined &&
    (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression")
  )
    return functionSignature(name, init, inline);

  return valueSignature(`${keyword} ${name}`, annotation, inline);
};

const isPublic = (member: { readonly accessibility?: ESTree.TSAccessibility | null }): boolean =>
  member.accessibility !== "private" && member.accessibility !== "protected";

/** The public members of a class as written, each with the findings of its annotations. */
const classMembers = (
  node: ESTree.Class,
  inline: Inline,
): ReadonlyArray<{ readonly text: string; readonly unannotated: ReadonlyArray<string> }> =>
  node.body.body.flatMap((member) => {
    switch (member.type) {
      case "PropertyDefinition":
      case "TSAbstractPropertyDefinition":
        return isPublic(member) && member.key.type !== "PrivateIdentifier"
          ? [{ text: inline(member), unannotated: [] }]
          : [];
      case "MethodDefinition":
      case "TSAbstractMethodDefinition": {
        if (!isPublic(member) || member.key.type === "PrivateIdentifier") return [];

        const key = member.computed ? `[${inline(member.key)}]` : inline(member.key);

        const prefix = `${member.static ? "static " : ""}${
          member.kind === "get" || member.kind === "set" ? `${member.kind} ` : ""
        }`;

        const signature = functionSignature(
          `${prefix}${key}`,
          member.value,
          inline,
          member.kind === "constructor" || member.kind === "set" ? "constructs" : "returns",
        );

        return [
          {
            text: signature.text,
            unannotated: signature.unannotated.map((finding) => `${finding} of ${code(key)}`),
          },
        ];
      }

      default:
        return [];
    }
  });

const classSignature = (name: string, node: ESTree.Class, inline: Inline): Signature => {
  const typeParameters = node.typeParameters == null ? "" : inline(node.typeParameters);

  const heritage =
    node.superClass === null
      ? ""
      : ` extends ${inline(node.superClass)}${node.superTypeArguments == null ? "" : inline(node.superTypeArguments)}`;

  const implemented =
    node.implements === undefined || node.implements.length === 0
      ? ""
      : ` implements ${node.implements.map((clause) => inline(clause)).join(", ")}`;

  const members = classMembers(node, inline);

  const constructor = node.body.body.find(
    (member): member is ESTree.MethodDefinition =>
      member.type === "MethodDefinition" && member.kind === "constructor",
  );

  const head = `class ${name}${typeParameters}${heritage}${implemented}`;

  return {
    text:
      members.length === 0
        ? head
        : `${head} {\n${members.map((member) => `  ${member.text.replaceAll("\n", "\n  ")};`).join("\n")}\n}`,
    inputs:
      constructor !== undefined && isPublic(constructor)
        ? constructor.value.params.map((parameter) => inline(parameter))
        : [],
    output: typeArguments(name, node.typeParameters),
    ...none,
    unannotated: members.flatMap((member) => member.unannotated),
  };
};

// ---------------------------------------------------------------------------------------------
// Declarations

type Declared = Omit<Declaration, "line" | "doc">;

const bindingNames = (pattern: ESTree.BindingPattern | ESTree.BindingRestElement): string[] => {
  switch (pattern.type) {
    case "Identifier":
      return [pattern.name];
    case "ObjectPattern":
      return pattern.properties.flatMap((property) =>
        bindingNames(property.type === "RestElement" ? property : property.value),
      );
    case "ArrayPattern":
      return pattern.elements.flatMap((element) => (element === null ? [] : bindingNames(element)));
    case "AssignmentPattern":
      return bindingNames(pattern.left);
    case "RestElement":
      return bindingNames(pattern.argument);
  }
};

const declared = (
  node: ESTree.Directive | ESTree.Statement | ESTree.ExportDefaultDeclarationKind,
  inline: Inline,
): ReadonlyArray<Declared> => {
  switch (node.type) {
    case "ExportNamedDeclaration":
      return node.declaration === null ? [] : declared(node.declaration, inline);
    case "ExportDefaultDeclaration": {
      const names = declared(node.declaration, inline);

      if (names.length > 0) return names;

      const expression =
        node.declaration.type === "ClassDeclaration" ||
        node.declaration.type === "TSInterfaceDeclaration" ||
        node.declaration.type === "FunctionDeclaration"
          ? null
          : unwrap(node.declaration);

      return [
        {
          local: "default",
          callable: isFunction(expression),
          signature:
            expression?.type === "ArrowFunctionExpression" ||
            expression?.type === "FunctionExpression"
              ? functionSignature("default", expression, inline)
              : valueSignature("export default", undefined, inline),
        },
      ];
    }

    case "VariableDeclaration":
      return node.declarations.flatMap((declarator) =>
        bindingNames(declarator.id).map((local) => ({
          local,
          callable: isFunction(declarator.init),
          signature: variableSignature(node.kind, local, declarator, inline),
        })),
      );
    case "FunctionDeclaration":
    case "TSDeclareFunction": {
      const local = node.id?.name ?? "default";

      return [{ local, callable: true, signature: functionSignature(local, node, inline) }];
    }

    case "ClassDeclaration": {
      const local = node.id?.name ?? "default";

      return [{ local, callable: false, signature: classSignature(local, node, inline) }];
    }

    case "TSInterfaceDeclaration": {
      const local = node.id.name;
      const typeParameters = node.typeParameters === null ? "" : inline(node.typeParameters);

      const heritage =
        node.extends.length === 0
          ? ""
          : ` extends ${node.extends.map((clause) => inline(clause)).join(", ")}`;

      return [
        {
          local,
          callable: false,
          signature: typeSignature(
            `interface ${local}${typeParameters}${heritage} ${inline(node.body)}`,
            node.typeParameters,
            typeArguments(local, node.typeParameters),
            inline,
          ),
        },
      ];
    }

    case "TSTypeAliasDeclaration": {
      const local = node.id.name;
      const typeParameters = node.typeParameters === null ? "" : inline(node.typeParameters);
      const output = inline(node.typeAnnotation);

      return [
        {
          local,
          callable: false,
          signature: typeSignature(
            `type ${local}${typeParameters} = ${output}`,
            node.typeParameters,
            output,
            inline,
          ),
        },
      ];
    }

    case "TSEnumDeclaration":
      return [
        {
          local: node.id.name,
          callable: false,
          signature: typeSignature(`enum ${node.id.name}`, null, node.id.name, inline),
        },
      ];
    case "TSModuleDeclaration":
      return node.id.type === "Identifier"
        ? [
            {
              local: node.id.name,
              callable: false,
              signature: typeSignature(`namespace ${node.id.name}`, null, node.id.name, inline),
            },
          ]
        : [];
    default:
      return [];
  }
};

/** The top-level declarations of a module, with the line, JSDoc, and signature of each. */
export const readDeclarations = (path: string, text: string): ModuleDeclarations => {
  const parsed = parseSync(path, text);
  const lineStarts = [0, ...[...text.matchAll(/\n/gu)].map((match) => match.index + 1)];
  const lineOf = (offset: number) => lineStarts.findLastIndex((start) => start <= offset) + 1;
  const inline = inlineOf(text, parsed.comments);
  const attached = new Set<Comment>();

  const declarations = parsed.program.body.flatMap((statement) => {
    const names = declared(statement, inline);

    if (names.length === 0) return [];

    // The JSDoc of a statement is the `/** */` comment that only whitespace separates from it.
    const comment = parsed.comments.findLast((candidate) => candidate.end <= statement.start);

    const doc =
      comment !== undefined &&
      comment.type === "Block" &&
      comment.value.startsWith("*") &&
      text.slice(comment.end, statement.start).trim() === ""
        ? comment
        : undefined;

    if (doc !== undefined) attached.add(doc);

    const line = lineOf(statement.start);
    const lines = doc === undefined ? [] : docLines(doc);

    return names.map((name) => ({ ...name, line, doc: lines }));
  });

  return {
    declarations,
    unattached: parsed.comments.flatMap((comment) =>
      comment.type === "Block" && !attached.has(comment)
        ? [{ line: lineOf(comment.start), doc: docLines(comment) }]
        : [],
    ),
  };
};

// ---------------------------------------------------------------------------------------------
// Documentation

/** One block tag of a JSDoc comment, such as `@remarks`, with its text up to the next tag. */
export interface Tag {
  readonly name: string;
  readonly text: string;
}

export interface Documentation {
  /** The first sentence of the description, with each inline link as its text. */
  readonly summary: string;
  readonly tags: ReadonlyArray<Tag>;
}

const tagStart = /^@([A-Za-z][\w-]*)(?:\s+(.*))?$/u;

const fence = /^\s*(?:`{3,}|~{3,})/u;

const inlineLink = /\{@link(?:code|plain)?\s+([^\s|}]+)(?:[\s|]+([^}]*))?\}/gu;

/** Prose with each `{@link target}` as its text, or as the target in a code span. */
export const plainLinks = (text: string): string =>
  text.replaceAll(inlineLink, (_link, target: string, label: string | undefined) =>
    label === undefined || label.trim() === "" ? code(target) : label.trim(),
  );

// Up to the first period that ends a sentence outside a code span.
const firstSentence = /^(?:[^`.]|`[^`]*`|\.(?!\s|$))*\./u;

const summaryOf = (description: ReadonlyArray<string>): string => {
  const start = description.findIndex((line) => line !== "");
  const lines = start === -1 ? [] : description.slice(start);
  const end = lines.findIndex((line) => line === "");
  const paragraph = plainLinks((end === -1 ? lines : lines.slice(0, end)).join(" ")).trim();

  return firstSentence.exec(paragraph)?.[0] ?? paragraph;
};

const withoutBlankEnds = (lines: ReadonlyArray<string>): ReadonlyArray<string> => {
  const start = lines.findIndex((line) => line.trim() !== "");
  const end = lines.findLastIndex((line) => line.trim() !== "");

  return start === -1 ? [] : lines.slice(start, end + 1);
};

/** The summary and the block tags of JSDoc lines. A line in a code fence never starts a tag. */
export const readDocumentation = (doc: ReadonlyArray<string>): Documentation => {
  const description: Array<string> = [];
  const tags: Array<{ readonly name: string; readonly lines: Array<string> }> = [];
  let fenced = false;

  for (const line of doc) {
    const tag = fenced ? null : tagStart.exec(line);

    if (tag === null) (tags.at(-1)?.lines ?? description).push(line);
    else tags.push({ name: tag[1] ?? "", lines: tag[2] === undefined ? [] : [tag[2]] });

    if (fence.test(line)) fenced = !fenced;
  }

  return {
    summary: summaryOf(description),
    tags: tags.map(({ name, lines }) => ({ name, text: withoutBlankEnds(lines).join("\n") })),
  };
};

/** The text of the tags named `name`, joined as paragraphs; `undefined` when none has text. */
export const tagText = (documentation: Documentation, name: string): string | undefined => {
  const texts = documentation.tags.flatMap((tag) =>
    tag.name === name && tag.text !== "" ? [tag.text] : [],
  );

  return texts.length === 0 ? undefined : texts.join("\n\n");
};

/** The block tags that a contract requires, with what each holds. */
export const contractTags = {
  remarks: "how it works",
  sideEffects: "what it writes, locks, reads, or waits for, or none",
  example: "one call as a consumer writes it",
  avoid: "the misuse that it prevents, and what to do instead",
} as const satisfies Readonly<Record<string, string>>;

/** What the contract of a declaration lacks: its summary, a required tag, or an annotation. */
export const contractGaps = (declaration: Declaration): ReadonlyArray<string> => {
  const documentation = readDocumentation(declaration.doc);

  return [
    ...(documentation.summary === "" ? ["has no summary sentence in its JSDoc"] : []),
    ...Object.entries(contractTags).flatMap(([tag, holds]) =>
      tagText(documentation, tag) === undefined ? [`has no @${tag} tag (${holds})`] : [],
    ),
    ...declaration.signature.unannotated,
  ];
};

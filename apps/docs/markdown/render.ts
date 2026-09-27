/**
 * The Markdown of a generated page. It is the page's MDX text with the edits that make it Markdown
 * at its read path: a marker line that names the source, the frontmatter title and description as
 * the heading and the first paragraph, each link resolved relative to the read path, each included
 * code file as a code block, and each MDX component in its Markdown form. Everything else keeps
 * the text of the source. Oxfmt formats the result, so that a table whose links change length
 * stays aligned.
 */
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import { extracts } from "@monoweb/conventions/documentation";
import type { Expression } from "estree";
import type { Nodes } from "mdast";
import type { MdxJsxFlowElement, MdxJsxTextElement } from "mdast-util-mdx";
import { format } from "oxfmt";
import { Match, Predicate } from "effect";
import { z } from "zod";
import { bodyOf, Frontmatter, type LinkResolver, mdxProcessor, type Resolution } from "./links";
import type { Page } from "./pages";

/** The recipe that writes the read paths. */
export const recipe = "just docs generate";

/** The first line of a generated file. It names the source, where an edit belongs. */
export const markerOf = (source: string): string =>
  `[//]: # "generated from ${source} by ${recipe}; do not edit"`;

const marker = /^\[\/\/\]: # "generated from (.+) by just docs generate; do not edit"(?:\n|$)/u;

/** The source that the first line of a generated file names; undefined for another file. */
export const markedSource = (text: string): string | undefined => marker.exec(text)?.[1];

export interface Rendered {
  readonly text: string;
  /** Why the page does not render correctly, such as a broken link. */
  readonly problems: ReadonlyArray<string>;
}

interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

type Element = MdxJsxFlowElement | MdxJsxTextElement;

/** A value that an MDX attribute expression writes literally. */
type Literal =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<Literal>
  | { readonly [key: string]: Literal };

/** The value of an attribute expression made of literals, arrays, and objects. */
const literalOf = (expression: Expression): Literal => {
  switch (expression.type) {
    case "Literal":
      if ("regex" in expression || "bigint" in expression)
        throw new Error("a regular expression or a bigint is not a literal value");

      return expression.value ?? null;
    case "TemplateLiteral":
      if (expression.expressions.length > 0) throw new Error("a template has expressions");

      return expression.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "ArrayExpression":
      return expression.elements.map((element) => {
        if (element === null || element.type === "SpreadElement")
          throw new Error("an array has a hole or a spread");

        return literalOf(element);
      });
    case "ObjectExpression":
      return Object.fromEntries(
        expression.properties.map((property) => {
          if (property.type !== "Property" || property.computed || property.kind !== "init")
            throw new Error("an object has a computed, spread, or accessor property");

          const { key, value } = property;

          const name =
            key.type === "Identifier"
              ? key.name
              : key.type === "Literal" && !("regex" in key) && !("bigint" in key)
                ? String(key.value)
                : undefined;

          if (name === undefined) throw new Error("an object has a key that is not a name");

          if (
            value.type === "ObjectPattern" ||
            value.type === "ArrayPattern" ||
            value.type === "RestElement" ||
            value.type === "AssignmentPattern"
          )
            throw new Error("an object has a pattern for a value");

          return [name, literalOf(value)];
        }),
      );
    default:
      throw new Error(`${expression.type} is not a literal value`);
  }
};

/** The value of a named attribute: its string, true when it has none, or its literal expression. */
const attributeOf = (element: Element, name: string): Literal | undefined => {
  for (const attribute of element.attributes) {
    if (attribute.type !== "mdxJsxAttribute" || attribute.name !== name) continue;

    const { value } = attribute;

    if (value === null || value === undefined) return true;

    // A string attribute is a primitive; an expression attribute is an object with its program.
    if (Predicate.isString(value)) return value;

    const statement = value.data?.estree?.body[0];

    if (statement?.type !== "ExpressionStatement")
      throw new Error(`the ${name} attribute is not an expression`);

    return literalOf(statement.expression);
  }

  return undefined;
};

/** Text that Markdown shows as written. */
const escaped = (text: string): string =>
  text.replaceAll(/[\\`*_[\]<]/gu, "\\$&").replace(/^[#>+=-]/u, "\\$&");

const GraphFlowProps = z.object({
  title: z.string(),
  rows: z.array(
    z.object({
      nodes: z.array(
        z.object({
          label: z.string(),
          tone: z.enum(["default", "accent", "muted"]).optional(),
          stretch: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

/**
 * GraphFlow in the form of its own Markdown children: the title in bold, then each row as one line
 * of nodes joined by arrows, with the accent node in bold and a receding node in italics.
 */
const graphFlow = (element: Element): string => {
  const { title, rows } = GraphFlowProps.parse({
    title: attributeOf(element, "title"),
    rows: attributeOf(element, "rows"),
  });

  return [
    `**${escaped(title)}**`,
    ...rows.map((row) =>
      row.nodes
        .map(({ label, tone }) =>
          Match.value(tone).pipe(
            Match.when("accent", () => `**${escaped(label)}**`),
            Match.when("muted", () => `_${escaped(label)}_`),
            Match.orElse(() => escaped(label)),
          ),
        )
        .join(" → "),
    ),
  ].join("\n\n");
};

/** The MDX components that a generated page may use, each with its Markdown form. */
const components = new Map<string, (element: Element) => string>([
  ["GraphFlow", graphFlow],
  [
    "HostedJourneys",
    (element) => {
      if (element.attributes.length > 0 || element.children.length > 0)
        throw new Error("HostedJourneys takes no attributes or children");

      return extracts.HostedJourneys(fileURLToPath(new URL("../../..", import.meta.url)));
    },
  ],
]);

/** A link destination in the form that Markdown accepts for any path. */
const destination = (url: string): string => (/[\s()<>]/u.test(url) ? `<${url}>` : url);

const titled = (node: { readonly title?: string | null | undefined }): string =>
  node.title === null || node.title === undefined ? "" : ` ${JSON.stringify(node.title)}`;

/** The offsets of a node in the text that its tree was parsed from. */
const span = (node: Nodes) => {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;

  if (start === undefined || end === undefined) throw new Error(`a ${node.type} has no position`);

  return { start, end };
};

/** A code file as a fenced block, with a fence longer than any backtick run inside it. */
const codeBlock = (path: string, code: string): string => {
  const fence = "`".repeat(
    Math.max(3, ...[...code.matchAll(/`{3,}/gu)].map(([run]) => run.length + 1)),
  );

  return `${fence}${posix.extname(path).slice(1)}\n${code.trimEnd()}\n${fence}`;
};

/** Renders a generated page to the Markdown of its read path. */
export const renderPage = async (
  page: Page,
  text: string,
  links: LinkResolver,
  read: (path: string) => string,
): Promise<Rendered> => {
  const problems: Array<string> = [];
  const edits: Array<Edit> = [];
  const { body, data } = bodyOf(text);
  const frontmatter = Frontmatter.safeParse(data);
  const directory = posix.dirname(page.readPath);

  if (!frontmatter.success) problems.push("declares no title and description in its frontmatter");

  /** The destination of a link at the read path; undefined when the link stays as written. */
  const destinationOf = (url: string, resolution: Resolution): string | undefined => {
    switch (resolution.type) {
      case "broken":
        problems.push(`${resolution.reason} (${url})`);

        return undefined;
      case "external":
        return undefined;
      case "page": {
        if (url.startsWith("#")) return undefined;

        const hash = resolution.fragment === "" ? "" : `#${resolution.fragment}`;

        return `${posix.relative(directory, resolution.page.readPath) || posix.basename(page.readPath)}${hash}`;
      }

      case "path": {
        const hash = resolution.fragment === "" ? "" : `#${resolution.fragment}`;
        const relative = posix.relative(directory, resolution.path) || ".";

        return `${resolution.directory ? `${relative}/` : relative}${hash}`;
      }
    }
  };

  /** A code file that the page includes, as a code block of its text. */
  const include = (element: Element): string => {
    const specifier = element.children
      .map((child) => ("value" in child ? child.value : ""))
      .join("")
      .trim();

    const resolution = links.resolve(specifier, page);

    if (
      element.attributes.length > 0 ||
      resolution.type !== "path" ||
      resolution.directory ||
      resolution.fragment !== "" ||
      /\.mdx?$/u.test(resolution.path)
    ) {
      problems.push(
        `includes ${specifier}; the Markdown includes only a code file, by its path alone`,
      );

      return "";
    }

    return codeBlock(resolution.path, read(resolution.path));
  };

  const visit = (node: Nodes): void => {
    switch (node.type) {
      case "link":
      case "image": {
        const url = destinationOf(node.url, links.resolve(node.url, page));

        if (url === undefined || url === node.url) return;

        const { start, end } = span(node);
        const open = body.lastIndexOf("](", end);

        if (open === -1 || open < start || body[end - 1] !== ")") {
          problems.push(`writes the link ${node.url} in a form that the generator cannot rewrite`);

          return;
        }

        edits.push({ start: open + 2, end: end - 1, text: `${destination(url)}${titled(node)}` });

        return;
      }

      case "definition": {
        const url = destinationOf(node.url, links.resolve(node.url, page));

        if (url === undefined || url === node.url) return;

        edits.push({
          ...span(node),
          text: `[${node.label ?? node.identifier}]: ${destination(url)}${titled(node)}`,
        });

        return;
      }

      case "mdxJsxFlowElement":
      case "mdxJsxTextElement": {
        const name = node.name ?? "";

        if (name === "include") {
          edits.push({ ...span(node), text: include(node) });

          return;
        }

        const component = components.get(name);

        if (component !== undefined) {
          try {
            edits.push({ ...span(node), text: component(node) });
          } catch (error) {
            problems.push(`gives <${name}> no Markdown form: ${String(error)}`);
          }

          return;
        }

        if (!/^[a-z]/u.test(name)) {
          problems.push(
            `uses <${name}>, which has no Markdown form; add one to the components of apps/docs/markdown/render.ts`,
          );

          return;
        }

        // An HTML element, such as <details>, keeps its text; its children may hold links.
        break;
      }

      case "mdxFlowExpression":
      case "mdxTextExpression":
        if (/^\s*\/\*[\s\S]*\*\/\s*$/u.test(node.value)) edits.push({ ...span(node), text: "" });
        else problems.push(`holds the expression {${node.value}}, which has no Markdown form`);

        return;
      case "mdxjsEsm":
        problems.push("imports or exports code; the MDX component map provides the components");

        return;
      default:
        break;
    }

    if ("children" in node) for (const child of node.children) visit(child);
  };

  visit(mdxProcessor.parse(body));

  let result = body;

  for (const edit of edits.toSorted((left, right) => right.start - left.start))
    result = `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`;

  const heading = frontmatter.success
    ? [`# ${frontmatter.data.title}`, "", frontmatter.data.description, ""]
    : [];

  const formatted = await format(
    page.readPath,
    [markerOf(page.source), "", ...heading, result.trimStart()].join("\n"),
  );

  for (const error of formatted.errors) problems.push(`does not format: ${error.message}`);

  return { text: formatted.code, problems };
};

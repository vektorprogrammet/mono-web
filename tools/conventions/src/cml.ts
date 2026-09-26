/**
 * Reads a Context Mapper (CML) document without the JVM toolchain.
 *
 * The reader knows the part of CML that `docs/model/contexts.cml` uses: top-level
 * `BoundedContext` declarations with their attributes and aggregates, and the relationships of
 * `ContextMap` declarations in the bracket notation, such as `A [U,OHS,PL] -> [D,CF] B`. Comments
 * and strings never count as declarations. A context map statement that it does not know is an
 * error, so a new notation fails the checks instead of dropping a relationship.
 */

// One token at a time: a block or line comment, a double- or single-quoted string, an arrow, an
// identifier, or any other character.
const token =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|<->|->|<-|[A-Za-z_]\w*|\S/gu;

const identifier = /^[A-Za-z_]\w*$/u;

export interface Aggregate {
  readonly name: string;
  readonly responsibilities: ReadonlyArray<string>;
}

export interface BoundedContext {
  readonly name: string;
  readonly domainVisionStatement: string | undefined;
  readonly responsibilities: ReadonlyArray<string>;
  readonly implementationTechnology: string | undefined;
  readonly aggregates: ReadonlyArray<Aggregate>;
}

export interface Relationship {
  readonly upstream: string;
  readonly downstream: string;
  /** Roles of the upstream side, such as `OHS` and `PL`; both sides of a partnership are `P`. */
  readonly upstreamRoles: ReadonlyArray<string>;
  readonly downstreamRoles: ReadonlyArray<string>;
  /** A partnership or shared kernel: neither side is upstream. */
  readonly symmetric: boolean;
  readonly exposedAggregates: ReadonlyArray<string>;
  readonly implementationTechnology: string | undefined;
}

export interface ContextModel {
  readonly contexts: ReadonlyArray<BoundedContext>;
  readonly relationships: ReadonlyArray<Relationship>;
  /** Statements that the reader does not know. */
  readonly errors: ReadonlyArray<string>;
}

const tokens = (cml: string): ReadonlyArray<string> =>
  [...cml.matchAll(token)].flatMap(([text]) =>
    text.startsWith("/*") || text.startsWith("//") ? [] : [text],
  );

const unquote = (text: string): string =>
  text.startsWith('"') || text.startsWith("'")
    ? text.slice(1, -1).replaceAll(/\\(.)/gu, "$1")
    : text;

/** The bounded contexts and context map relationships of a CML document. */
export const readContextModel = (cml: string): ContextModel => {
  const list = tokens(cml);
  const contexts: Array<BoundedContext> = [];
  const relationships: Array<Relationship> = [];
  const errors: Array<string> = [];
  let index = 0;

  const peek = (offset = 0): string => list[index + offset] ?? "";

  const next = (): string => {
    const text = peek();

    index += 1;

    return text;
  };

  // Skips a `{ ... }` block whose opening brace is the current token.
  const skipBlock = () => {
    let depth = 0;

    do {
      const text = next();

      if (text === "{") depth += 1;
      else if (text === "}") depth -= 1;
    } while (depth > 0 && index < list.length);
  };

  // `name = value, value, ...` after the name: strings and identifiers separated by commas.
  const values = (): ReadonlyArray<string> => {
    const read = [unquote(next())];

    while (peek() === ",") {
      index += 1;
      read.push(unquote(next()));
    }

    return read;
  };

  // The attributes of a block whose opening brace is the current token. Nested blocks are
  // skipped unless `nested` reads them.
  const attributes = (
    nested?: (keyword: string) => boolean,
  ): ReadonlyMap<string, ReadonlyArray<string>> => {
    const read = new Map<string, ReadonlyArray<string>>();

    index += 1;

    while (index < list.length && peek() !== "}") {
      if (identifier.test(peek()) && peek(1) === "=") {
        const name = next();

        index += 1;
        read.set(name, values());
      } else if (nested?.(peek()) === true) continue;
      else if (peek() === "{") skipBlock();
      else index += 1;
    }

    index += 1;

    return read;
  };

  const boundedContext = () => {
    const name = next();
    const aggregates: Array<Aggregate> = [];

    // `implements A, B` and `realizes C` name the subdomains and the context that it realizes.
    while (peek() === "implements" || peek() === "realizes") {
      index += 1;
      values();
    }

    const read =
      peek() === "{"
        ? attributes((keyword) => {
            if (keyword !== "Aggregate" || !identifier.test(peek(1))) return false;

            index += 1;

            const aggregate = next();

            aggregates.push({
              name: aggregate,
              responsibilities: peek() === "{" ? (attributes().get("responsibilities") ?? []) : [],
            });

            return true;
          })
        : new Map<string, ReadonlyArray<string>>();

    contexts.push({
      name,
      domainVisionStatement: read.get("domainVisionStatement")?.[0],
      responsibilities: read.get("responsibilities") ?? [],
      implementationTechnology: read.get("implementationTechnology")?.[0],
      aggregates,
    });
  };

  const roles = (): ReadonlyArray<string> => {
    if (peek() !== "[") return [];

    index += 1;

    const read: Array<string> = [];

    while (index < list.length && peek() !== "]") {
      const text = next();

      if (text !== ",") read.push(text);
    }

    index += 1;

    return read;
  };

  const relationship = () => {
    const left = next();
    const leftRoles = roles();
    const arrow = next();
    const rightRoles = roles();
    const right = next();

    if (!["->", "<-", "<->"].includes(arrow) || !identifier.test(right)) {
      errors.push(
        `the context map statement that starts with ${left} is not in the bracket notation, such as A [U,OHS,PL] -> [D,CF] B`,
      );

      while (index < list.length && peek() !== "}" && !identifier.test(peek())) index += 1;

      return;
    }

    if (peek() === ":") index += 2;

    const read = peek() === "{" ? attributes() : new Map<string, ReadonlyArray<string>>();
    const leftUpstream = arrow !== "<-";

    relationships.push({
      upstream: leftUpstream ? left : right,
      downstream: leftUpstream ? right : left,
      upstreamRoles: leftUpstream ? leftRoles : rightRoles,
      downstreamRoles: leftUpstream ? rightRoles : leftRoles,
      symmetric: arrow === "<->",
      exposedAggregates: read.get("exposedAggregates") ?? [],
      implementationTechnology: read.get("implementationTechnology")?.[0],
    });
  };

  const contextMap = () => {
    while (index < list.length && peek() !== "{") index += 1;

    index += 1;

    while (index < list.length && peek() !== "}") {
      if (identifier.test(peek()) && peek(1) === "=") {
        index += 2;
        values();
      } else if (peek() === "contains") {
        index += 1;
        values();
      } else if (identifier.test(peek())) relationship();
      else {
        errors.push(`the context map has the unexpected token ${peek()}`);
        index += 1;
      }
    }

    index += 1;
  };

  while (index < list.length) {
    const text = next();

    if (text === "BoundedContext" && identifier.test(peek())) boundedContext();
    else if (text === "ContextMap") contextMap();
    else if (text === "{") {
      index -= 1;
      skipBlock();
    }
  }

  return { contexts, relationships, errors };
};

/** The names of the top-level `BoundedContext` declarations, in document order. */
export const boundedContextNames = (cml: string): ReadonlyArray<string> =>
  readContextModel(cml).contexts.map((context) => context.name);

/** The folder name of a bounded context: its CML name in kebab case, `TeamApplications` as `team-applications`. */
export const contextFolderName = (name: string): string =>
  name.replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();

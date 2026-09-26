/**
 * Reads bounded context names from a Context Mapper (CML) document without the JVM toolchain.
 * Only top-level `BoundedContext <Name>` declarations count; comments and strings never do.
 */

// One token at a time: a block or line comment, a double- or single-quoted string, an
// identifier, a brace, or any other character.
const token =
  /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|[A-Za-z_]\w*|\S/gu;

const identifier = /^[A-Za-z_]\w*$/u;

/** The names of the top-level `BoundedContext` declarations, in document order. */
export const boundedContextNames = (cml: string): ReadonlyArray<string> => {
  const names: Array<string> = [];
  let depth = 0;
  let previous = "";

  for (const [text] of cml.matchAll(token)) {
    if (text.startsWith("/*") || text.startsWith("//")) continue;

    if (text === "{") depth += 1;
    else if (text === "}") depth -= 1;
    else if (depth === 0 && previous === "BoundedContext" && identifier.test(text))
      names.push(text);

    previous = text;
  }

  return names;
};

/** The folder name of a bounded context: its CML name in kebab case, `TeamApplications` as `team-applications`. */
export const contextFolderName = (name: string): string =>
  name.replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2").toLowerCase();

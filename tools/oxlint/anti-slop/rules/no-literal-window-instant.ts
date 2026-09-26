/**
 * Rejects literal window bounds in journey code that the real clock has not passed yet.
 *
 * The defect: a journey fixture writes, as a literal, an instant that the code under test compares
 * with the real clock or uses as a bound relative to it. The instant expires: the journey passes
 * until the real clock passes it and then fails. The journey seeds hard-coded an admission period
 * that ended on 2026-09-30, so every journey built on them would have failed from 2026-10-01.
 *
 * A window bound is the place that an ISO date or date-time literal binds:
 * - In SQL text in a string or template: a column whose name ends in start_at, end_at, expires_at,
 *   scheduled_at, or settled_at, as an INSERT value, an INSERT ... SELECT item, an assignment, or
 *   a comparison. A literal inside `${...}`, or in the parameter array after the SQL text, binds
 *   the column of its placeholder.
 * - A variable whose name ends in StartAt, EndAt, ExpiresAt, ScheduledAt, or SettledAt, in camel,
 *   Pascal, or snake case.
 * - A property whose name ends in ExpiresAt, ScheduledAt, or SettledAt. Journey properties named
 *   for a start or an end carry event times and imported records that no clock compares; seeds
 *   write their windows in SQL text or in variables.
 *
 * The rule reports such a literal only while it lies after the lint clock: the time of the lint
 * run, or the `now` option. An instant that the clock has passed compares the same way forever, so
 * it cannot expire, and historical rows pass. Findings only disappear as time passes, so code that
 * nobody touches never starts to fail lint.
 *
 * A runner that pins the backend's clock passes the pinned literal to `journeyClock` in
 * `tools/e2e/journey-clock.ts`. A call argument is no window bound, and the windows derive from
 * the clock that the call returns.
 */
import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

// An ISO 8601 date with an optional time and UTC offset. The groups are the year, month, day,
// hour, minute, second, fraction, and offset.
const isoInstant =
  /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?\b/gu;

// A cheap test before the full match; `isoInstant` is global and keeps state between tests.
const hasDate = /\d{4}-\d{2}-\d{2}/u;

const utcOffset = /^([+-])(\d{2}):?(\d{2})$/u;

// A statement keyword that makes a string SQL text.
const sqlStatement = /\b(?:insert\s+into|update\s+[\w."]+\s+set|select|delete\s+from)\b/iu;

const variableBounds = new Set(["start", "end", "expires", "scheduled", "settled"]);

const propertyBounds = new Set(["expires", "scheduled", "settled"]);

// Expressions that hand their operand on unchanged.
const passThrough = new Set([
  "ArrayExpression",
  "LogicalExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** The name ends in a bound word and `at`, such as `periodEndAt` or `EXPIRES_AT`. */
const endsInBound = (name: string, bounds: ReadonlySet<string>): boolean => {
  const words = name
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split("_")
    .filter((word) => word !== "");
  return words.at(-1) === "at" && bounds.has(words.at(-2) ?? "");
};

/** The epoch milliseconds of a matched instant; undefined when the digits name no calendar instant. */
const instantTime = (match: RegExpMatchArray): number | undefined => {
  const part = (index: number): number => Number(match[index] ?? 0);
  const time =
    Date.UTC(part(1), part(2) - 1, part(3), part(4), part(5), part(6)) +
    Math.floor(Number(`0.${match[7] ?? 0}`) * 1000);
  const date = new Date(time);
  if (
    date.getUTCFullYear() !== part(1) ||
    date.getUTCMonth() !== part(2) - 1 ||
    date.getUTCDate() !== part(3) ||
    date.getUTCHours() !== part(4) ||
    date.getUTCMinutes() !== part(5) ||
    date.getUTCSeconds() !== part(6)
  )
    return undefined;
  const offset = utcOffset.exec(match[8] ?? "");
  if (offset === null) return time;
  const minutes = Number(offset[2]) * 60 + Number(offset[3]);
  return time - (offset[1] === "-" ? -minutes : minutes) * 60_000;
};

/** The lint clock: the `now` option, or the time of the lint run. */
const lintClock = (context: Context): number => {
  const option = context.options?.[0];
  const now =
    typeof option === "object" && option !== null && !Array.isArray(option)
      ? option.now
      : undefined;
  if (now === undefined) return Date.now();
  const time = Date.parse(String(now));
  if (!Number.isFinite(time)) {
    throw new Error("no-literal-window-instant: the `now` option must be an RFC 3339 instant");
  }
  return time;
};

/** The start of the balanced parenthesized group that closes at `close`, or -1. */
const groupStart = (sql: string, close: number): number => {
  let depth = 0;
  let quoted = false;
  for (let index = close; index >= 0; index -= 1) {
    const character = sql[index];
    if (character === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (character === ")") depth += 1;
    else if (character === "(" && --depth === 0) return index;
  }
  return -1;
};

/** The column list of an INSERT that ends `head`. */
const insertColumns = (head: string, pattern: RegExp): ReadonlyArray<string> | undefined =>
  pattern
    .exec(head)?.[1]
    ?.split(",")
    .map((column) => column.trim().replace(/"/gu, "").toLowerCase());

/** The column of the item after `commas` top-level commas in the tuple that opens at `open`. */
const tupleColumn = (sql: string, open: number, commas: number): string | undefined => {
  let index = open - 1;
  while (index >= 0) {
    while (/\s/u.test(sql[index] ?? "")) index -= 1;
    if (sql[index] !== ",") break;
    index -= 1;
    while (/\s/u.test(sql[index] ?? "")) index -= 1;
    if (sql[index] !== ")") return undefined;
    index = groupStart(sql, index) - 1;
  }
  const head = sql.slice(0, index + 1);
  if (!/\bvalues$/iu.test(head)) return undefined;
  return insertColumns(
    head.slice(0, -"values".length),
    /\binsert\s+into\s+[\w."]+\s*\(([^()]*)\)[^;()]*$/iu,
  )?.[commas];
};

/** The column of an INSERT ... SELECT item that starts at `start`. */
const selectColumn = (sql: string, start: number): string | undefined => {
  const insert = [
    ...sql.slice(0, start).matchAll(/\binsert\s+into\s+[\w."]+\s*\(([^()]*)\)\s*select\s/giu),
  ].at(-1);
  if (insert === undefined) return undefined;
  const items = sql.slice(insert.index + insert[0].length, start);
  if (items.includes(";") || /\bfrom\b/iu.test(items.replace(/'[^']*'|\([^()]*\)/gu, ""))) {
    return undefined;
  }
  let depth = 0;
  let quoted = false;
  let commas = 0;
  for (const character of items) {
    if (character === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) commas += 1;
  }
  return insertColumns(insert[0], /\(([^()]*)\)/u)?.[commas];
};

/** The column that the value starting at `valueStart` binds in SQL text, when the text says. */
const sqlColumn = (sql: string, valueStart: number): string | undefined => {
  let start = sql[valueStart - 1] === "'" ? valueStart - 1 : valueStart;
  const typed = /\b(?:timestamptz|timestamp|date)\s*$/iu.exec(sql.slice(0, start));
  if (typed !== null) start -= typed[0].length;
  const compared = /([a-z_]\w*)\s*(?:=|<=|>=|<|>)\s*$/iu.exec(sql.slice(0, start));
  if (compared !== null) return compared[1]?.toLowerCase();
  let depth = 0;
  let commas = 0;
  let quoted = false;
  for (let index = start - 1; index >= 0; index -= 1) {
    const character = sql[index];
    if (character === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (character === ";" && depth === 0) break;
    else if (character === ")") depth += 1;
    else if (character === "," && depth === 0) commas += 1;
    else if (character === "(") {
      if (depth === 0) return tupleColumn(sql, index, commas);
      depth -= 1;
    }
  }
  return selectColumn(sql, start);
};

/** A window-bound column name, or undefined. */
const boundColumn = (column: string | undefined): string | undefined =>
  column !== undefined && endsInBound(column, variableBounds) ? column : undefined;

/** Text that may hold instants, with each `${...}` replaced by a placeholder. */
interface Text {
  readonly value: string;
  /** The offset of each placeholder in `value`, in expression order. */
  readonly placeholders: ReadonlyArray<number>;
  /** The literal parts: their offset in `value`, their source offset, and their raw text. */
  readonly parts: ReadonlyArray<{ readonly at: number; readonly source: number; readonly raw: string }>;
}

const templateText = (context: Context, template: ESTree.TemplateLiteral): Text => {
  let value = "";
  const placeholders: Array<number> = [];
  const parts: Array<{ at: number; source: number; raw: string }> = [];
  template.quasis.forEach((quasi, index) => {
    const raw = quasi.value.raw;
    // An element span can include its `${` and `}` delimiters.
    const span = context.sourceCode.text.slice(quasi.start, quasi.end);
    parts.push({ at: value.length, source: quasi.start + Math.max(span.indexOf(raw), 0), raw });
    value += raw;
    if (index < template.expressions.length) {
      placeholders.push(value.length);
      value += "$__";
    }
  });
  return { value, placeholders, parts };
};

const stringText = (context: Context, literal: ESTree.Node): Text => {
  const raw = context.sourceCode.text.slice(literal.start + 1, literal.end - 1);
  return { value: raw, placeholders: [], parts: [{ at: 0, source: literal.start + 1, raw }] };
};

/** SQL text of a call argument, or undefined. */
const sqlText = (context: Context, argument: ESTree.Node | undefined): Text | undefined => {
  if (argument?.type === "Literal") {
    return typeof argument.value === "string" && sqlStatement.test(argument.value)
      ? stringText(context, argument)
      : undefined;
  }
  if (argument?.type !== "TemplateLiteral") return undefined;
  const text = templateText(context, argument);
  return sqlStatement.test(text.value) ? text : undefined;
};

/** `new Date(instant)` and `Date.parse(instant)` keep the instant of their argument. */
const keepsInstant = (
  call: ESTree.CallExpression | ESTree.NewExpression,
  child: ESTree.Node,
): boolean => {
  if (call.arguments[0] !== child) return false;
  const callee = call.callee;
  if (callee.type === "Identifier") return call.type === "NewExpression" && callee.name === "Date";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "Date" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "parse"
  );
};

/** The window bound that a string or template binds outside its own SQL text, or undefined. */
const bindingBound = (context: Context, node: ESTree.Node): string | undefined => {
  let child: ESTree.Node = node;
  let parent = node.parent;
  while (parent !== null) {
    switch (parent.type) {
      case "ConditionalExpression":
        if (parent.test === child) return undefined;
        break;
      case "CallExpression":
      case "NewExpression":
        if (!keepsInstant(parent, child)) return undefined;
        break;
      case "TemplateLiteral": {
        const text = templateText(context, parent);
        const placeholder = text.placeholders[parent.expressions.indexOf(child)];
        if (placeholder === undefined || !sqlStatement.test(text.value)) return undefined;
        return boundColumn(sqlColumn(text.value, placeholder));
      }
      case "Property": {
        if (parent.value !== child || parent.computed) return undefined;
        const name =
          parent.key.type === "Identifier"
            ? parent.key.name
            : parent.key.type === "Literal"
              ? String(parent.key.value)
              : "";
        return endsInBound(name, propertyBounds) ? name : undefined;
      }
      case "VariableDeclarator":
        if (parent.init !== child || parent.id.type !== "Identifier") return undefined;
        return endsInBound(parent.id.name, variableBounds) ? parent.id.name : undefined;
      case "AssignmentExpression": {
        const target = parent.left;
        if (parent.right !== child) return undefined;
        if (target.type === "Identifier") {
          return endsInBound(target.name, variableBounds) ? target.name : undefined;
        }
        if (target.type !== "MemberExpression" || target.property.type !== "Identifier") {
          return undefined;
        }
        return endsInBound(target.property.name, propertyBounds) ? target.property.name : undefined;
      }
      default:
        if (!passThrough.has(parent.type)) return undefined;
    }
    if (parent.type === "ArrayExpression") {
      // A parameter array after SQL text binds each element to the column of its `$n`.
      const call = parent.parent;
      if (call.type === "CallExpression" || call.type === "NewExpression") {
        const text = sqlText(context, call.arguments[call.arguments.indexOf(parent) - 1]);
        if (text === undefined) return undefined;
        const marker = new RegExp(`\\$${parent.elements.indexOf(child) + 1}(?!\\d)`, "gu");
        return [...text.value.matchAll(marker)]
          .map((placeholder) => boundColumn(sqlColumn(text.value, placeholder.index)))
          .find((column) => column !== undefined);
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return undefined;
};

/** Ban literal window bounds that the real clock will pass. */
export const noLiteralWindowInstantRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a literal ISO instant as a window bound in journey code (a start, end, expiry, schedule, or settlement in SQL text, a variable, or a property) while the instant lies after the lint clock. The code under test compares such an instant with the real clock, so the journey passes until the clock passes the instant and then fails; derive it from `tools/e2e/journey-clock.ts`.",
    },
    messages: {
      literalWindowInstant:
        "Derive `{{bound}}` from `admissionJourneyClock` or `journeyClock` in `tools/e2e/journey-clock.ts`. The literal {{instant}} expires: the journey passes until the real clock passes it, then fails.",
    },
    schema: [
      {
        type: "object",
        properties: { now: { type: "string" } },
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    let clock = 0;

    const reportFuture = (text: Text, bound: (at: number) => string | undefined) => {
      for (const part of text.parts) {
        for (const match of part.raw.matchAll(isoInstant)) {
          const time = instantTime(match);
          if (time === undefined || time <= clock) continue;
          const name = bound(part.at + match.index);
          if (name === undefined) continue;
          const start = part.source + match.index;
          context.report({
            node: { range: [start, start + match[0].length] },
            messageId: "literalWindowInstant",
            data: { bound: name, instant: match[0] },
          });
        }
      }
    };

    const check = (node: ESTree.Node, text: Text) => {
      if (sqlStatement.test(text.value)) {
        reportFuture(text, (at) => boundColumn(sqlColumn(text.value, at)));
      } else {
        reportFuture(text, () => bindingBound(context, node));
      }
    };

    return {
      before() {
        clock = lintClock(context);
      },
      Literal(node) {
        if (typeof node.value === "string" && hasDate.test(node.value)) {
          check(node, stringText(context, node));
        }
      },
      TemplateLiteral(node) {
        if (node.quasis.some((quasi) => hasDate.test(quasi.value.raw))) {
          check(node, templateText(context, node));
        }
      },
    };
  },
});

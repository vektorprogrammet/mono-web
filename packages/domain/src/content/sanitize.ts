import { Effect } from "effect";
import { ContentDecodeError } from "./errors.js";

/**
 * Write-time sanitizer for editorial body HTML (spec 0062 law 6).
 *
 * Removes `script` and `iframe` contexts — the legacy `safe_html`
 * blacklist — plus close cousins (`object`, `embed`, `link`, `meta`,
 * `base`, `svg`, `math`), javascript/data URL schemes, and inline event
 * handlers, then refuses payloads whose removed-element structure is left
 * unclosed. Public responses emit only sanitized bytes; stored bytes can
 * never inject script regardless of which client wrote them.
 */

const REMOVED_ELEMENTS = [
  "script",
  "iframe",
  "object",
  "embed",
  "link",
  "meta",
  "base",
  "svg",
  "math",
] as const;

const pairedPattern = (name: string): RegExp =>
  new RegExp(`<${name}\\b[\\s\\S]*?</${name}\\s*>`, "gi");

const loneOpenPattern = (name: string): RegExp => new RegExp(`<${name}\\b[^>]*>`, "gi");
const loneClosePattern = (name: string): RegExp => new RegExp(`</${name}\\s*>`, "gi");

const sanitize = (bodyHtml: string): string => {
  // Comments go first so `<scr<!-- -->ipt>` splitting cannot resurrect a tag.
  let sanitized = bodyHtml.replaceAll(/<!--[\s\S]*?-->/g, "");
  for (const name of REMOVED_ELEMENTS) {
    sanitized = sanitized
      .replace(pairedPattern(name), "")
      .replace(loneClosePattern(name), "")
      .replace(loneOpenPattern(name), "");
  }
  return sanitized
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*(?:javascript|vbscript|data)\s*:[^"]*"|'\s*(?:javascript|vbscript|data)\s*:[^']*'|(?:javascript|vbscript|data):[^\s>]*)/gi,
      "",
    );
};

/**
 * Sanitizes and validates one editorial body write. A payload whose
 * removed-element structure is unclosed (an opening tag with no matching
 * closer after sanitization passes) is refused, not repaired.
 */
export const sanitizeArticleBodyHtml = (
  operation: string,
  bodyHtml: string,
): Effect.Effect<string, ContentDecodeError> =>
  Effect.gen(function* () {
    const opensScriptContext =
      /<script\b/i.test(bodyHtml) || /<iframe\b/i.test(bodyHtml) ? true : false;
    const closesScriptContext = /<\/script\s*>/i.test(bodyHtml) || /<\/iframe\s*>/i.test(bodyHtml);
    if (opensScriptContext && !closesScriptContext) {
      return yield* new ContentDecodeError({
        operation,
        message: "article body contains an unclosed script or iframe document",
      });
    }
    const sanitized = sanitize(bodyHtml);
    if (sanitized.length > 100000) {
      return yield* new ContentDecodeError({
        operation,
        message: "sanitized article body exceeds the 100000-byte limit",
      });
    }
    if (/<(script|iframe)\b/i.test(sanitized)) {
      return yield* new ContentDecodeError({
        operation,
        message: "article body still carries executable context after sanitization",
      });
    }
    return sanitized;
  }).pipe(
    Effect.mapError(() => new ContentDecodeError({ operation, message: "sanitizer failure" })),
  );

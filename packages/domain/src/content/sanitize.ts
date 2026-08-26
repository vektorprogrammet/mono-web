import { Effect } from "effect";
import { defaultTreeAdapter, parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";
import { ContentDecodeError } from "./errors.js";

/**
 * Parser-backed write-time sanitizer for editorial body HTML (spec 0062 law
 * 6). parse5 applies the HTML parsing algorithm, including character-reference
 * decoding in attributes, before policy checks run.
 */

const REMOVED_ELEMENTS: Record<string, true> = {
  base: true,
  embed: true,
  iframe: true,
  link: true,
  math: true,
  meta: true,
  object: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  svg: true,
};

const ELEMENTS_REQUIRING_A_CLOSE_TAG: Record<string, true> = {
  iframe: true,
  math: true,
  object: true,
  noscript: true,
  script: true,
  style: true,
  template: true,
  svg: true,
};

const URL_ATTRIBUTES: Record<string, true> = {
  action: true,
  background: true,
  cite: true,
  formaction: true,
  href: true,
  poster: true,
  src: true,
  "xlink:href": true,
};

const SAFE_URL_SCHEMES: Record<string, true> = {
  http: true,
  https: true,
  mailto: true,
  tel: true,
};

type ParentNode = DefaultTreeAdapterTypes.ParentNode;
type Element = DefaultTreeAdapterTypes.Element;

const unsafeScheme = (value: string): string | undefined => {
  const canonical = value
    .normalize("NFKC")
    .replace(/[\u0000-\u0020\u007f-\u009f\u00a0]|\p{White_Space}/gu, "")
    .toLowerCase();
  const separator = canonical.indexOf(":");
  if (separator <= 0) return undefined;
  const scheme = canonical.slice(0, separator);
  return SAFE_URL_SCHEMES[scheme] === true ? undefined : scheme;
};

const sanitizeChildren = (parent: ParentNode): string | undefined => {
  for (const node of [...parent.childNodes]) {
    if (defaultTreeAdapter.isCommentNode(node)) {
      defaultTreeAdapter.detachNode(node);
      continue;
    }
    if (!defaultTreeAdapter.isElementNode(node)) continue;

    const element: Element = node;
    for (const attribute of element.attrs) {
      const qualifiedName =
        attribute.prefix === undefined ? attribute.name : `${attribute.prefix}:${attribute.name}`;
      if (
        URL_ATTRIBUTES[qualifiedName] === true ||
        (attribute.prefix === undefined && URL_ATTRIBUTES[attribute.name] === true)
      ) {
        const scheme = unsafeScheme(attribute.value);
        if (scheme !== undefined) {
          return `article body contains disallowed ${scheme}: URL scheme`;
        }
      }
    }

    const tagName = element.tagName.toLowerCase();
    if (REMOVED_ELEMENTS[tagName] === true) {
      if (
        ELEMENTS_REQUIRING_A_CLOSE_TAG[tagName] === true &&
        element.sourceCodeLocation?.startTag !== undefined &&
        element.sourceCodeLocation.endTag === undefined
      ) {
        return `article body contains an unclosed ${tagName} document`;
      }
      defaultTreeAdapter.detachNode(element);
      continue;
    }

    element.attrs = element.attrs.filter((attribute) => {
      const name = attribute.name.toLowerCase();
      return (
        !name.startsWith("on") &&
        name !== "srcdoc" &&
        name !== "srcset" &&
        name !== "ping" &&
        name !== "style"
      );
    });
    const nestedRejection = sanitizeChildren(element);
    if (nestedRejection !== undefined) return nestedRejection;
  }
  return undefined;
};

const sanitize = (bodyHtml: string): { readonly html: string; readonly rejection?: string } => {
  const fragment = parseFragment(bodyHtml, { sourceCodeLocationInfo: true });
  const rejection = sanitizeChildren(fragment);
  return rejection === undefined ? { html: serialize(fragment) } : { html: "", rejection };
};

/** Sanitizes and validates one editorial body write before persistence. */
export const sanitizeArticleBodyHtml = (
  operation: string,
  bodyHtml: string,
): Effect.Effect<string, ContentDecodeError> =>
  Effect.try({
    try: () => sanitize(bodyHtml),
    catch: () => new ContentDecodeError({ operation, message: "sanitizer failure" }),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.rejection !== undefined) {
        return Effect.fail(new ContentDecodeError({ operation, message: result.rejection }));
      }
      if (result.html.trim().length === 0) {
        return Effect.fail(
          new ContentDecodeError({
            operation,
            message: "sanitized article body must contain non-empty content",
          }),
        );
      }
      if (new TextEncoder().encode(result.html).byteLength > 100000) {
        return Effect.fail(
          new ContentDecodeError({
            operation,
            message: "sanitized article body exceeds the 100000-byte limit",
          }),
        );
      }
      return Effect.succeed(result.html);
    }),
  );

const pathPrefix = "/undersokelse/";
const framePrefix = "~";
const frameSuffix = ".~";

const encodeBase64Url = (value: string): string => {
  const binary = String.fromCodePoint(...new TextEncoder().encode(value));
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};

const decodeBase64Url = (value: string): string | undefined => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return undefined;
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

/** Builds the reversible, route-safe public path for an opaque survey ID. */
export const schoolSurveyPath = (surveyId: string): string =>
  `${pathPrefix}${framePrefix}${encodeBase64Url(surveyId)}${frameSuffix}`;

/** Decodes a canonical path segment, while retaining pre-codec raw paths. */
export const schoolSurveyIdFromPathSegment = (segment: string): string | undefined => {
  if (!segment.startsWith(framePrefix) || !segment.endsWith(frameSuffix)) return segment;
  return decodeBase64Url(segment.slice(framePrefix.length, -frameSuffix.length));
};

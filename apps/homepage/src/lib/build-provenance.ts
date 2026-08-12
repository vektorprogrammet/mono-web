declare const __BUILD_COMMIT__: string;
declare const __BUILD_CONTENT_DIGEST__: string;
declare const __BUILD_ROUTE_DIGEST__: string;

function requireBuildValue(
  name: string,
  value: string | undefined,
  pattern: RegExp,
): string {
  if (value === undefined || !pattern.test(value)) {
    throw new Error(`Invalid or missing ${name}; homepage build provenance is required`);
  }
  return value;
}

const rawBuildCommit = typeof __BUILD_COMMIT__ === "string" ? __BUILD_COMMIT__ : undefined;
const rawBuildContentDigest =
  typeof __BUILD_CONTENT_DIGEST__ === "string" ? __BUILD_CONTENT_DIGEST__ : undefined;
const rawBuildRouteDigest =
  typeof __BUILD_ROUTE_DIGEST__ === "string" ? __BUILD_ROUTE_DIGEST__ : undefined;

export const BUILD_COMMIT = requireBuildValue(
  "BUILD_COMMIT",
  rawBuildCommit,
  /^[0-9a-f]{40}$/,
);
export const BUILD_CONTENT_DIGEST = requireBuildValue(
  "BUILD_CONTENT_DIGEST",
  rawBuildContentDigest,
  /^sha256:[0-9a-f]{64}$/,
);
export const BUILD_ROUTE_DIGEST = requireBuildValue(
  "BUILD_ROUTE_DIGEST",
  rawBuildRouteDigest,
  /^sha256:[0-9a-f]{64}$/,
);

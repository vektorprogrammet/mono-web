import { Data } from "effect";

export interface NativePreflightEndpointMetadata {
  readonly method: string;
  readonly path: string;
}

const routeTemplateMatches = (template: string, pathname: string): boolean => {
  const templateSegments = template.split("/");
  const pathSegments = pathname.split("/");

  if (templateSegments.length !== pathSegments.length) return false;

  return templateSegments.every((segment, index) => {
    if (segment.startsWith(":") || (segment.startsWith("{") && segment.endsWith("}"))) {
      return pathSegments[index]?.length !== 0;
    }

    return segment === pathSegments[index];
  });
};

/** Builds preflight method lookup from route metadata, never from a second route table. */
export const nativePreflightMethodResolver = (
  endpoints: ReadonlyArray<NativePreflightEndpointMetadata>,
): ((pathname: string) => ReadonlyArray<string>) => {
  const routes = endpoints.map(({ method, path }) => ({
    method: method.toUpperCase(),
    path,
  }));

  return (pathname) => [
    ...new Set(
      routes
        .values()
        .filter((endpoint) => routeTemplateMatches(endpoint.path, pathname))
        .map((endpoint) => endpoint.method)
        .toArray(),
    ),
  ];
};

export type NativePreflightDecision =
  | { readonly _tag: "Ready"; readonly methods: ReadonlyArray<string> }
  | { readonly _tag: "HeaderMalformed" }
  | { readonly _tag: "MethodNotAllowed"; readonly methods: ReadonlyArray<string> }
  | { readonly _tag: "RouteNotFound"; readonly requestedMethod: string };

export const NativePreflightDecision = Data.taggedEnum<NativePreflightDecision>();

/** Applies request-method and header precedence to methods from authoritative metadata. */
export const decideNativePreflight = (input: {
  readonly pathname: string;
  readonly requestedMethod: string | null;
  readonly headersAllowed: boolean;
  readonly methodsForPath: (pathname: string) => ReadonlyArray<string>;
}): NativePreflightDecision => {
  if (input.requestedMethod === null || !/^[A-Z]+$/u.test(input.requestedMethod)) {
    return NativePreflightDecision.HeaderMalformed();
  }

  const methods = input.methodsForPath(input.pathname);

  if (methods.length === 0) {
    return NativePreflightDecision.RouteNotFound({ requestedMethod: input.requestedMethod });
  }

  const methodExists =
    methods.includes(input.requestedMethod) ||
    (input.requestedMethod === "HEAD" && methods.includes("GET"));

  if (!methodExists) return NativePreflightDecision.MethodNotAllowed({ methods });

  return input.headersAllowed
    ? NativePreflightDecision.Ready({ methods })
    : NativePreflightDecision.HeaderMalformed();
};

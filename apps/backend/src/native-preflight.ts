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
export const makeNativePreflightMethodResolver = (
  endpoints: ReadonlyArray<NativePreflightEndpointMetadata>,
): ((pathname: string) => ReadonlyArray<string>) => {
  const routes = endpoints.map(({ method, path }) => ({
    method: method.toUpperCase(),
    path,
  }));
  return (pathname) => [
    ...new Set(
      routes
        .filter((endpoint) => routeTemplateMatches(endpoint.path, pathname))
        .map((endpoint) => endpoint.method),
    ),
  ];
};

export type NativePreflightDecision =
  | { readonly _tag: "Ready"; readonly methods: ReadonlyArray<string> }
  | { readonly _tag: "HeaderMalformed" }
  | { readonly _tag: "MethodNotAllowed"; readonly methods: ReadonlyArray<string> }
  | { readonly _tag: "RouteNotFound"; readonly requestedMethod: string };

/** Applies request-method and header precedence to methods from authoritative metadata. */
export const decideNativePreflight = (input: {
  readonly pathname: string;
  readonly requestedMethod: string | null;
  readonly headersAllowed: boolean;
  readonly methodsForPath: (pathname: string) => ReadonlyArray<string>;
}): NativePreflightDecision => {
  if (input.requestedMethod === null || !/^[A-Z]+$/u.test(input.requestedMethod)) {
    return { _tag: "HeaderMalformed" };
  }
  const methods = input.methodsForPath(input.pathname);
  if (methods.length === 0) {
    return { _tag: "RouteNotFound", requestedMethod: input.requestedMethod };
  }
  const methodExists =
    methods.includes(input.requestedMethod) ||
    (input.requestedMethod === "HEAD" && methods.includes("GET"));
  if (!methodExists) return { _tag: "MethodNotAllowed", methods };
  return input.headersAllowed ? { _tag: "Ready", methods } : { _tag: "HeaderMalformed" };
};

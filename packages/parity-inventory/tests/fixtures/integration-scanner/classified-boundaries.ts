const cache = new Map<string, string>();
type JourneyResponse = { readonly status: number };
type JourneyHttpClientShape = {
  readonly request: (request: { readonly url: string }) => Promise<JourneyResponse>;
};

export const methods = {
  delete: async (key: string): Promise<boolean> => cache.delete(key),
  backend: async (origin: string): Promise<Response> => {
    return fetch(new URL("/api/health", origin));
  },
  configured: async (url: string): Promise<Response> => fetch(url),
  configuredPath: async (assignmentPath: string): Promise<Response> => fetch(assignmentPath),
  journey: async (
    http: JourneyHttpClientShape,
    request: { readonly url: string },
  ): Promise<{ readonly status: number }> => http.request(request),
  contact: async (
    ingress: { readonly backendOrigin: string },
    input: Request,
  ): Promise<Response> => {
    if (new URL(input.url).origin !== ingress.backendOrigin) {
      throw new Error("Unsupported contact backend origin");
    }
    return fetch(input);
  },
  inspect: (response: { request(): unknown }): unknown => {
    return response.request();
  },
  geolocate: async (): Promise<Response> => {
    return fetch("http://ipinfo.io/fixture");
  },
};

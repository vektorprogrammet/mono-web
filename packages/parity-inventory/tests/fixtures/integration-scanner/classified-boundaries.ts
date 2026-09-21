const cache = new Map<string, string>();
type JourneyHttpClientShape = {
  readonly request: (request: { readonly url: string }) => Promise<Response>;
};

export const methods = {
  delete: async (key: string): Promise<boolean> => cache.delete(key),
  backend: async (origin: string): Promise<Response> => {
    return fetch(new URL("/api/health", origin));
  },
  configured: async (url: string): Promise<Response> => fetch(url),
  journey: async (
    http: JourneyHttpClientShape,
    request: { readonly url: string },
  ): Promise<Response> => http.request(request),
  contact: async (
    ingress: { readonly backendOrigin: string },
    input: Request,
  ): Promise<Response> => {
    if (new URL(input.url).origin !== ingress.backendOrigin) {
      throw new Error("Unsupported contact backend origin");
    }
    return fetch(input);
  },
  geolocate: async (): Promise<Response> => {
    return fetch("http://ipinfo.io/fixture");
  },
};

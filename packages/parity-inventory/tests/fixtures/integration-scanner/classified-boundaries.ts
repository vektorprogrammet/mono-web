const cache = new Map<string, string>();

export const methods = {
  delete: async (key: string): Promise<boolean> => cache.delete(key),
  backend: async (origin: string): Promise<Response> => {
    return fetch(new URL("/api/health", origin));
  },
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

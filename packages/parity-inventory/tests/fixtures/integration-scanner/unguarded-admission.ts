const normalizedLoopbackHost = (host: string): string =>
  host === "localhost" || host === "::1" ? "127.0.0.1" : host;
void normalizedLoopbackHost;

class LocalNetworkGuard {
  readonly #allowedOrigins = new Set<string>();

  addHttp(origin: string): void {
    const url = new URL(origin);
    this.#allowedOrigins.add(url.origin);
  }

  readonly fetchLoopback = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "http:" || !this.#allowedOrigins.has(url.origin)) {
      throw new Error("network guard rejected a non-loopback destination");
    }
    return fetch(request);
  };
}

export async function run(origin: string): Promise<Response> {
  const guard = new LocalNetworkGuard();
  guard.addHttp(origin);
  return guard.fetchLoopback(`${origin}/remote`);
}

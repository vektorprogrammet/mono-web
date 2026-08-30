import assert from "node:assert/strict";

const normalizedLoopbackHost = (host: string): string =>
  host === "localhost" || host === "::1" ? "127.0.0.1" : host;

class LocalNetworkGuard {
  readonly #allowedOrigins = new Set<string>();

  addHttp(origin: string): void {
    const url = new URL(origin);
    assert.equal(url.protocol, "http:");
    assert.equal(normalizedLoopbackHost(url.hostname), "127.0.0.1");
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

export async function runLoopbackRehearsal(origin: string): Promise<void> {
  const guard = new LocalNetworkGuard();
  guard.addHttp(origin);
  await guard.fetchLoopback(`${origin}/ready`);
  await guard.fetchLoopback(`${origin}/rehearse`);
}

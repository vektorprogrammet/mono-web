class LocalNetworkGuard {
  readonly fetch = async (input: Parameters<typeof fetch>[0]): Promise<Response> => fetch(input);
}

export async function callRemoteProvider(): Promise<Response> {
  const guard: LocalNetworkGuard = new LocalNetworkGuard();
  const [response] = await Promise.all([
    guard.fetch("https://api.example.test/remote"),
    guard.fetch("https://api.example.test/remote"),
  ]);
  return response;
}

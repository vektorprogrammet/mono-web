class LocalNetworkGuard {
  readonly fetch = async (input: Parameters<typeof fetch>[0]): Promise<Response> => fetch(input);
}

export async function callRemoteProvider(): Promise<Response> {
  const guard: LocalNetworkGuard = new LocalNetworkGuard();
  return guard.fetch("https://api.example.test/remote");
}

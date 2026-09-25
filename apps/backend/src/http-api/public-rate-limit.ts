/** A fixed-window request count per key, held in one backend process. */
export interface PublicRateLimit {
  readonly consume: (key: string, now: string) => boolean;
}

/**
 * The Fetch Request does not expose a verified peer address. Treat all public
 * callers as one trust boundary instead of trusting spoofable forwarding headers.
 */
export const publicRateLimitKey = (_request: Request): string => "public";

export const publicRateLimit = (maxRequests = 5, windowMilliseconds = 60_000): PublicRateLimit => {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) {
    throw new Error("public rate limit must be a positive safe integer");
  }

  if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1) {
    throw new Error("public rate limit window must be a positive safe integer");
  }

  const buckets = new Map<string, { readonly startedAt: number; readonly count: number }>();

  return {
    consume(key, now) {
      const timestamp = Date.parse(now);

      if (Number.isNaN(timestamp)) return false;
      const current = buckets.get(key);

      if (current === undefined || timestamp - current.startedAt >= windowMilliseconds) {
        buckets.set(key, { startedAt: timestamp, count: 1 });

        return true;
      }

      if (current.count >= maxRequests) return false;
      buckets.set(key, { startedAt: current.startedAt, count: current.count + 1 });

      return true;
    },
  };
};

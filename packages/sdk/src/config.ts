// Server-side: process.env.API_URL, Client-side: import.meta.env.VITE_API_URL.
// Configuration is deliberately explicit: an absent value is not replaced with
// a production destination. Client operations validate the base URL lazily.
export const apiUrl: string | undefined =
  (typeof process !== "undefined" ? process.env?.API_URL : undefined) ??
  (typeof import.meta !== "undefined" ? import.meta.env?.VITE_API_URL : undefined)

export const isFixtureMode: boolean =
  (typeof process !== "undefined" && process.env?.API_MODE === "fixture") ||
  (typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_API_MODE === "fixture") ||
  false

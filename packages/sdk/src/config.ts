const DEFAULT_API_URL = "https://vektorprogrammet-production.up.railway.app";

// Server-side: process.env.API_URL, Client-side: import.meta.env.VITE_API_URL
export const apiUrl: string =
  (typeof process !== "undefined" && process.env?.API_URL) ||
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  DEFAULT_API_URL;

export const isFixtureMode: boolean =
  (typeof process !== "undefined" && process.env?.API_MODE === "fixture") ||
  (typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_API_MODE === "fixture") ||
  false;

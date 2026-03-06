const DEFAULT_API_URL = "https://vektorprogrammet-production.up.railway.app";

export const apiUrl: string =
  (typeof import.meta !== "undefined" && import.meta.env?.VITE_API_URL) ||
  DEFAULT_API_URL;

export const isFixtureMode: boolean =
  (typeof import.meta !== "undefined" &&
    import.meta.env?.VITE_API_MODE === "fixture") ||
  false;

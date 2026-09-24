import { Schema, Option } from "effect";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

const Theme = Schema.Literals(["light", "dark", "system"]);

type Theme = typeof Theme.Type;

interface ThemeContext {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  resolved: "light" | "dark";
}

const ThemeContext = createContext<ThemeContext | null>(null);

function getSystemTheme(): "light" | "dark" {
  if (globalThis.window === undefined) return "light";

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "light" | "dark") {
  document.documentElement.classList.toggle("dark", resolved === "dark");
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("system");
  const [systemTheme, setSystemTheme] = useState<"light" | "dark">("light");
  const resolved = theme === "system" ? systemTheme : theme;

  useEffect(() => {
    setThemeState(
      Option.getOrElse(
        Schema.decodeUnknownOption(Theme)(localStorage.getItem("theme")),
        () => "system",
      ),
    );
  }, []);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    localStorage.setItem("theme", next);
  }, []);

  useEffect(() => {
    if (theme !== "system") return;

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setSystemTheme(getSystemTheme());
    handler();
    mq.addEventListener("change", handler);

    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  return <ThemeContext value={{ theme, setTheme, resolved }}>{children}</ThemeContext>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);

  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");

  return ctx;
}

import "./globals.css";

import { type ReactNode, StrictMode } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  type MetaFunction,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from "react-router";
import { QueryProvider } from "@vektorprogrammet/sdk";
import { ThemeProvider } from "./lib/theme";

export const meta: MetaFunction = () => [
  {
    charset: "utf-8",
    title: "Vektor Dashboard",
    viewport: "width=device-width,initial-scale=1",
  },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/vektor-logo-circle.svg" />

        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `
  try {
    const theme = localStorage.getItem('theme');
    if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark');
    }
  } catch(e) {}
`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <QueryProvider>{children}</QueryProvider>
        </ThemeProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function App() {
  return (
    <StrictMode>
      <Outlet />
    </StrictMode>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isRouteError = isRouteErrorResponse(error);

  return (
    <html lang="no">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Feil</title>
      </head>
      <body className="grid h-dvh place-items-center bg-gray-50">
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold">
            {isRouteError ? error.status : "Feil"}
          </h1>
          <p className="text-gray-500">
            {isRouteError
              ? error.status === 404
                ? "Siden ble ikke funnet"
                : error.statusText
              : "Noe gikk galt"}
          </p>
          <a href="/dashboard" className="text-blue-600 hover:underline">
            Tilbake til dashbordet
          </a>
        </div>
      </body>
    </html>
  );
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default App;

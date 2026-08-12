import { useEffect, type ReactNode } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from "react-router";
import "~/index.css";
import icon from "/images/vektor-logo-circle.svg";
import logo from "/images/vektor-logo.svg";
import { resolveHomepageRequest, type HomepageRequest } from "~/lib/host";

declare global {
  interface Window {
    __MONO_WEB_HYDRATED__?: boolean;
  }
}
type RootLoaderArgs = {
  request: Request;
};

export function loader({ request }: RootLoaderArgs): HomepageRequest {
  const host = request.headers.get("host");
  if (!host) throw new Response("Missing Host", { status: 421 });
  return resolveHomepageRequest(host);
}

export function Layout({ children }: { children: ReactNode }) {
  const requestInfo = useRouteLoaderData<typeof loader>("root") ?? {
    stage: "p000",
    host: "",
  };
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <link rel="icon" href={icon} />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="theme-color" content="#E2F4FA" />
        <meta name="robots" content="noindex, nofollow" />
        <meta property="og:type" content="website" />
        {requestInfo.host && <meta property="og:url" content={`https://${requestInfo.host}/`} />}
        <meta property="og:image" content={logo} />
        <meta property="og:description" content="Vektorprogrammet DEV CONTENT homepage." />
        <meta property="og:site_name" content="Vektorprogrammet DEV CONTENT" />
        <meta
          name="description"
          content="Vektorprogrammet DEV CONTENT homepage for non-production development."
        />
        <link rel="manifest" href="/manifest.json" />
        <title>{"Vektorprogrammet · DEV CONTENT"}</title>
        <Meta />
        <Links />
      </head>
      <body className="bg-vektor-bg">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  useEffect(() => {
    window.__MONO_WEB_HYDRATED__ = true;
  }, []);
  return <Outlet />;
}

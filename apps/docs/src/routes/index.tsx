import { createFileRoute } from "@tanstack/react-router";
import { DocsRoutePage, loadPage } from "@/components/docs-page";

// The home page is the start page of the documentation, which includes the README.
export const Route = createFileRoute("/")({
  component: Home,
  loader: () => loadPage([]),
});

function Home() {
  return <DocsRoutePage data={Route.useLoaderData()} />;
}

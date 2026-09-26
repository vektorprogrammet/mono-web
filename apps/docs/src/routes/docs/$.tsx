import { createFileRoute, redirect } from "@tanstack/react-router";
import { DocsRoutePage, loadPage } from "@/components/docs-page";

export const Route = createFileRoute("/docs/$")({
  component: Page,
  loader: async ({ params }) => {
    const slugs = (params._splat ?? "").split("/").filter((slug) => slug.length > 0);

    // The start page lives at the root of the site.
    if (slugs.length === 0) throw redirect({ to: "/" });

    return loadPage(slugs);
  },
});

function Page() {
  return <DocsRoutePage data={Route.useLoaderData()} />;
}

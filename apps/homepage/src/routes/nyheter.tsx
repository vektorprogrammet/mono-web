import { Link, useLoaderData } from "react-router";
import { loadNewsListing } from "~/lib/news.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const department = url.searchParams.get("avdeling") ?? undefined;
  // Fresh server-side read per render; no cache, no fixture fallback.
  return await loadNewsListing(department);
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Nyheter() {
  const { listing, notice } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-8 px-6 py-16">
      <h1 className="font-bold text-3xl">Nyheter</h1>
      {notice?.kind === "filter-degraded" && (
        <p className="rounded border border-amber-400 bg-amber-50 p-4 text-sm" role="status">
          Avdelingen du valgte finnes ikke lenger. Viser alle nyheter.
        </p>
      )}
      {listing.articles.length === 0 ? (
        <p role="status">Ingen nyheter å vise.</p>
      ) : (
        <ul className="flex flex-col gap-6">
          {listing.articles.map((article) => (
            <li key={article.slug} className="flex flex-col gap-1">
              <Link to={`/nyhet/${article.slug}`} className="font-semibold text-lg hover:underline">
                {article.sticky ? "★ " : ""}
                {article.title}
              </Link>
              <p className="text-muted-foreground text-sm">
                {article.authorDisplayName} ·{" "}
                {new Date(article.publishedAt).toLocaleDateString("nb-NO")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

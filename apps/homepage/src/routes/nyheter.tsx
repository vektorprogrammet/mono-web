import { Link, useLoaderData } from "react-router";
import { NEWS_PAGE_SIZE, paginateNewsListing } from "~/lib/news";
import { loadNewsListing } from "~/lib/news.server";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const department = url.searchParams.get("avdeling") ?? undefined;
  const requestedPage = Number(url.searchParams.get("side") ?? "1");
  const data = await loadNewsListing(department);
  const pageCount = Math.max(1, Math.ceil(data.listing.articles.length / NEWS_PAGE_SIZE));
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? Math.min(requestedPage, pageCount)
      : 1;
  return {
    ...data,
    listing: paginateNewsListing(data.listing, page),
    department,
    page,
    pageCount,
  };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Nyheter() {
  const { listing, notice, department, page, pageCount } = useLoaderData<typeof loader>();
  const pageHref = (targetPage: number): string => {
    const query = new URLSearchParams();
    if (department !== undefined) query.set("avdeling", department);
    query.set("side", String(targetPage));
    return `/nyheter?${query.toString()}`;
  };
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
      {pageCount > 1 && (
        <nav aria-label="Sider" className="flex items-center justify-between">
          {page > 1 ? (
            <Link to={pageHref(page - 1)} className="font-semibold hover:underline">
              Forrige
            </Link>
          ) : (
            <span />
          )}
          <span>
            Side {page} av {pageCount}
          </span>
          {page < pageCount ? (
            <Link to={pageHref(page + 1)} className="font-semibold hover:underline">
              Neste
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </main>
  );
}

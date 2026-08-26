import { Link, useLoaderData } from "react-router";
import { loadNewsArticle } from "~/lib/news.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { readonly slug?: string };
}) {
  const slug = params.slug ?? "";
  const versionParam = new URL(request.url).searchParams.get("versjon") ?? undefined;
  // Fresh server-side read per render; a draft/withdrawn/unknown slug is a
  // plain 404 indistinguishable from any other missing page.
  return await loadNewsArticle(slug, versionParam ?? undefined);
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Nyhet() {
  const { article, otherNews } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto grid max-w-5xl gap-10 px-6 py-16 md:grid-cols-[minmax(0,1fr)_16rem]">
      <div className="flex min-w-0 flex-col gap-6">
        <article>
          <h1 className="font-bold text-3xl">{article.title}</h1>
          <p className="text-muted-foreground text-sm">
            {article.authorDisplayName} ·{" "}
            {new Date(article.publishedAt).toLocaleDateString("nb-NO")}
          </p>
          {/* bodyHtml is sanitized at every backend write before it can reach
            a published immutable version (spec law 6 / DoD 15). */}
          <div
            className="prose max-w-none pt-4"
            dangerouslySetInnerHTML={{ __html: article.bodyHtml }}
          />
        </article>
        {article.previousVersions.length > 0 && (
          <nav aria-label="Tidligere versjoner" className="flex flex-col gap-1">
            <h2 className="font-semibold text-sm uppercase">Tidligere versjoner</h2>
            <ul>
              {article.previousVersions.map((version) => (
                <li key={version.versionNumber}>
                  <Link to={version.urlPath} className="text-sm hover:underline">
                    Versjon {version.versionNumber} ·{" "}
                    {new Date(version.publishedAt).toLocaleDateString("nb-NO")}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
      <aside aria-labelledby="other-news-heading">
        <h2 id="other-news-heading" className="font-semibold text-sm uppercase">
          Andre nyheter
        </h2>
        {otherNews.length === 0 ? (
          <p className="mt-2 text-muted-foreground text-sm">Ingen andre nyheter.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-3">
            {otherNews.map((summary) => (
              <li key={summary.slug}>
                <Link to={`/nyhet/${summary.slug}`} className="text-sm hover:underline">
                  {summary.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </main>
  );
}

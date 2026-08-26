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
  const { article } = useLoaderData<typeof loader>();
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-16">
      <article>
        <h1 className="font-bold text-3xl">{article.title}</h1>
        <p className="text-muted-foreground text-sm">
          {article.authorDisplayName} · {new Date(article.publishedAt).toLocaleDateString("nb-NO")}
        </p>
        {/* bodyHtml is sanitized at write time by the backend domain sanitizer
            (spec law 6 / DoD 15) and re-checked in the loader before render. */}
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
    </main>
  );
}

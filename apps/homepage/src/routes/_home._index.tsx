import { buttonVariants } from "@/components/ui/button";
import { Link, useLoaderData } from "react-router";
import { loadNewsTeaser } from "~/lib/news.server";
import { Button } from "~/components/ui/button";
import { BUILD_COMMIT, BUILD_CONTENT_DIGEST, BUILD_ROUTE_DIGEST } from "~/lib/build-provenance";
import type { PublishedNewsSummary } from "@vektorprogrammet/domain/content";
import { DEV_CONTENT, DEV_CONTENT_SOURCE, type DevContent } from "~/lib/dev-content";

export async function loader(): Promise<
  DevContent & { newsTeaser: readonly PublishedNewsSummary[] }
> {
  const teaser = await loadNewsTeaser();
  // Fresh server-side news read per render; DEV_CONTENT still feeds
  // sponsors/teams/statistics until their own journeys cut over, but no
  // article byte comes from it (spec law 2).
  return { ...DEV_CONTENT, newsTeaser: teaser.articles };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function MainPage() {
  const content = useLoaderData<typeof loader>();
  const featuredSponsors = content.sponsors.filter((sponsor) => sponsor.featured);
  const supportingSponsors = content.sponsors.filter((sponsor) => !sponsor.featured);

  return (
    <main className="flex-grow">
      <div className="border-b border-amber-300 bg-vektor-index-blue md:flex md:min-h-[32rem] md:pt-14">
        <div className="flex w-full flex-col items-center text-center md:w-1/2 md:p-8">
          <img
            className="w-2/4 pt-12 pb-14 md:hidden"
            src="/images/vektor-logo.svg"
            alt="Vektorprogrammet DEV CONTENT"
          />
          <img
            className="mx-auto my-auto h-full w-full max-w-xl p-5 pt-14 md:mr-0 md:ml-auto md:pt-0"
            src="/images/mainPage/vektor-forsidebilde.png"
            alt="Nøytral DEV CONTENT-illustrasjon"
          />
        </div>
        <div className="w-full p-6 text-center md:mt-24 md:w-1/2 md:p-10 md:text-left">
          <p className="mb-3 font-semibold text-amber-900 text-sm uppercase tracking-wide">
            DEV CONTENT · {DEV_CONTENT_SOURCE}
          </p>
          <h1 className="mb-4 font-bold text-4xl dark:text-text-dark">Vektorprogrammet</h1>
          <p className="mb-6 text-left text-md md:w-4/5 md:text-xl dark:text-text-dark">
            Dette er en syntetisk, ikke-produksjonell hjemmeside for lokal Worker- og
            innholdsverifisering.
          </p>
          <p className="mb-6 text-left text-sm dark:text-text-dark">
            Bygg {BUILD_COMMIT} · innholds-digest {BUILD_CONTENT_DIGEST} · rutekart-digest{" "}
            {BUILD_ROUTE_DIGEST}
          </p>
          <Button variant="green" asChild>
            <Link to="/team">Se DEV CONTENT-team</Link>
          </Button>
        </div>
      </div>

      <div className="info-background mb-0 flex max-w-full flex-row flex-wrap items-center justify-center gap-24 pt-32 pb-32 text-center md:mt-20 md:gap-40">
        <StatCard
          number={content.statistics.assistantCount}
          title="Assistenter"
          text="Syntetiske assistentdata for lokal verifisering."
          to="/assistenter"
        />
        <StatCard
          number={content.statistics.teamMemberCount}
          title="I team"
          text="Syntetiske teamdata for den samme byggede artefakten."
          to="/team"
        />
      </div>

      <NewsTeaser articles={content.newsTeaser} />

      <div className="mx-auto flex max-w-4xl flex-col gap-16 px-6 py-16">
        <SponsorGroup title="DEV CONTENT-hovedsponsorer" sponsors={featuredSponsors} />
        <SponsorGroup title="DEV CONTENT-samarbeidspartnere" sponsors={supportingSponsors} />
      </div>
    </main>
  );
}

function StatCard({
  number,
  title,
  text,
  to,
}: {
  number: number;
  title: string;
  text: string;
  to: string;
}) {
  return (
    <div className="flex max-w-96 flex-col gap-5 text-vektor-bg">
      <div>
        <div className="font-bold text-4xl">{number}</div>
        <p className="text-xl md:text-2xl">{title}</p>
      </div>
      <p className="max-w-80 text-sm md:max-w-96 md:text-xl">{text}</p>
      <Link to={to} className={buttonVariants({ variant: "green" })} prefetch="intent">
        Les mer
      </Link>
    </div>
  );
}

function SponsorGroup({ title, sponsors }: { title: string; sponsors: DevContent["sponsors"] }) {
  return (
    <section aria-labelledby={title}>
      <h2 id={title} className="mb-8 text-center font-bold text-3xl text-vektor-DARKblue">
        {title}
      </h2>
      <div className="flex flex-row flex-wrap justify-around gap-8">
        {sponsors.map((sponsor) => (
          <a
            className="flex h-40 w-40 items-center justify-center rounded-lg border border-vektor-blue bg-white p-6 shadow-sm"
            href={sponsor.href}
            key={sponsor.id}
          >
            <img
              className="h-auto max-h-full w-auto max-w-full"
              src={sponsor.image}
              alt={sponsor.name}
            />
          </a>
        ))}
      </div>
    </section>
  );
}

function NewsTeaser({
  articles,
}: {
  readonly articles: readonly {
    readonly slug: string;
    readonly title: string;
    readonly sticky: boolean;
    readonly authorDisplayName: string;
    readonly hasImage: boolean;
    readonly imageUrl?: string;
  }[];
}) {
  if (articles.length === 0) return null;
  return (
    <section aria-labelledby="news-teaser-heading" className="mx-auto max-w-4xl px-6 pb-8">
      <h2 id="news-teaser-heading" className="mb-6 font-bold text-2xl">
        Nyheter
      </h2>
      <ul className="flex flex-col gap-4">
        {articles.map((article) => (
          <li key={article.slug} className="flex items-center gap-4">
            {/* Sticky leads; imageless entries never render an <img>. */}
            {!article.hasImage && null}
            <Link to={`/nyhet/${article.slug}`} className="hover:underline">
              {article.sticky ? "★ " : ""}
              {article.title}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

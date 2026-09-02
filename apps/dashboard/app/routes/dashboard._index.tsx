import { Schema as S } from "effect";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard._index";

/**
 * Landing summary contract shared with the foldkit shell's LandingSummary
 * (Available / Unavailable). Values render only when the backend warranted
 * them for the signed-in actor; any read failure renders the explicit
 * Unavailable state. No fixture fallback exists in this route module.
 */
const LandingSummary = S.Union([
  S.Struct({
    _tag: S.Literal("Available"),
    name: S.String,
  }),
  S.Struct({ _tag: S.Literal("Unavailable") }),
]);
export type LandingSummary = S.Schema.Type<typeof LandingSummary>;

export async function loader({ request }: Route.LoaderArgs): Promise<{ summary: LandingSummary }> {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const profile = await client.profile.readOwnProfile({ headers: {} });
    return {
      summary: S.decodeUnknownSync(LandingSummary)({
        _tag: "Available",
        name: `${profile.body.firstName} ${profile.body.lastName}`,
      }),
    };
  } catch {
    return { summary: { _tag: "Unavailable" } };
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Index() {
  const { summary } = useLoaderData<typeof loader>();

  if (summary._tag === "Unavailable") {
    return (
      <section className="flex w-full min-w-0 flex-col items-center" role="alert">
        <h1 className="mb-2 font-semibold text-2xl">Oversikten kunne ikke hentes</h1>
        <p className="text-muted-foreground">Last siden på nytt og prøv igjen.</p>
      </section>
    );
  }

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-6 font-semibold text-2xl">Velkommen, {summary.name}</h1>
      <div className="w-full max-w-3xl rounded-md border p-6 text-center" role="status">
        <h2 className="font-semibold text-lg">Oversiktsdata er ikke tilgjengelig</h2>
        <p className="mt-2 text-muted-foreground">
          Assistent-, søknads- og intervjuoversikten er midlertidig utilgjengelig.
        </p>
      </div>
    </section>
  );
}

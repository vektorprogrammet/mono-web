import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    department: S.String,
    activeAssistants: S.Number,
    pendingApplications: S.Number,
    upcomingInterviews: S.Number,
  }),
  S.Struct({ _tag: S.Literal("Unavailable") }),
]);
export type LandingSummary = S.Schema.Type<typeof LandingSummary>;

const summaryCards: Array<{
  key: "activeAssistants" | "pendingApplications" | "upcomingInterviews";
  label: string;
}> = [
  { key: "activeAssistants", label: "Aktive assistenter" },
  { key: "pendingApplications", label: "Ventende søknader" },
  { key: "upcomingInterviews", label: "Kommende intervjuer" },
];

export async function loader({ request }: Route.LoaderArgs): Promise<{ summary: LandingSummary }> {
  const cookie = await requireAuth(request);
  const client = createAuthenticatedClient(cookie, request);

  try {
    const dashboard = await client.me.dashboard();
    return {
      summary: S.decodeUnknownSync(LandingSummary)({
        _tag: "Available",
        name: dashboard.name,
        department: dashboard.department,
        activeAssistants: dashboard.activeAssistants,
        pendingApplications: dashboard.pendingApplications,
        upcomingInterviews: dashboard.upcomingInterviews,
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
      <h1 className="mb-2 font-semibold text-2xl">Velkommen, {summary.name}</h1>
      <p className="mb-10 text-muted-foreground">{summary.department}</p>
      <div className="grid w-full max-w-7xl grid-cols-1 gap-4 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:px-8">
        {summaryCards.map(({ key, label }) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-bold text-3xl">{summary[key]}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

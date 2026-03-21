import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isFixtureMode } from "@vektorprogrammet/sdk";
import { useLoaderData } from "react-router";
import { requireAuth } from "../lib/auth.server";
import { createAuthenticatedClient } from "../lib/api.server";
import type { Route } from "./+types/dashboard.statistikk._index";

type Statistics = {
  totalApplicants: number;
  accepted: number;
  rejected: number;
  interviewed: number;
  assignedAssistants: number;
};

const mockStatistics: Statistics = {
  totalApplicants: 142,
  accepted: 98,
  rejected: 30,
  interviewed: 128,
  assignedAssistants: 95,
};

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { statistics: mockStatistics };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);

  try {
    const statistics = await client.admin.admissionStats();
    return { statistics: statistics ?? null };
  } catch {
    return { statistics: null };
  }
}

const statCards: Array<{ key: keyof Statistics; label: string }> = [
  { key: "totalApplicants", label: "Totalt antall sokere" },
  { key: "accepted", label: "Tatt opp" },
  { key: "rejected", label: "Avvist" },
  { key: "interviewed", label: "Intervjuet" },
  { key: "assignedAssistants", label: "Tildelte assistenter" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Statistikk() {
  const { statistics } = useLoaderData<typeof loader>();
  const stats = (statistics ?? mockStatistics) as Statistics;

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-10 font-semibold text-2xl">Statistikk</h1>
      <div className="grid w-full max-w-7xl grid-cols-1 gap-4 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:px-8">
        {statCards.map(({ key, label }) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-bold text-3xl">{stats[key]}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

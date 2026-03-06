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
import type { Route } from "./+types/dashboard._index";

type DashboardData = {
  name: string;
  department: string;
  activeAssistants: number;
  pendingApplications: number;
  upcomingInterviews: number;
};

const mockDashboard: DashboardData = {
  name: "Admin",
  department: "NTNU",
  activeAssistants: 95,
  pendingApplications: 12,
  upcomingInterviews: 5,
};

export async function loader({ request }: Route.LoaderArgs) {
  if (isFixtureMode) return { dashboard: mockDashboard };

  const token = requireAuth(request);
  const client = createAuthenticatedClient(token);
  const { data } = await client.GET("/api/me/dashboard");

  return { dashboard: data ?? null };
}

const summaryCards: Array<{ key: keyof Pick<DashboardData, "activeAssistants" | "pendingApplications" | "upcomingInterviews">; label: string }> = [
  { key: "activeAssistants", label: "Aktive assistenter" },
  { key: "pendingApplications", label: "Ventende soknader" },
  { key: "upcomingInterviews", label: "Kommende intervjuer" },
];

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Index() {
  const { dashboard } = useLoaderData<typeof loader>();
  const data = (dashboard ?? mockDashboard) as DashboardData;

  return (
    <section className="flex w-full min-w-0 flex-col items-center">
      <h1 className="mb-2 font-semibold text-2xl">
        Velkommen, {data.name}
      </h1>
      <p className="mb-10 text-muted-foreground">{data.department}</p>
      <div className="grid w-full max-w-7xl grid-cols-1 gap-4 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-3 lg:px-8">
        {summaryCards.map(({ key, label }) => (
          <Card key={key}>
            <CardHeader>
              <CardTitle className="text-sm text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-bold text-3xl">{data[key]}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

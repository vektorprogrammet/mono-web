import { Schema } from "effect";
import { Form, Link, data, useLoaderData, useNavigation } from "react-router";
import {
  InterviewReport,
  InterviewReportQuery,
  interviewScoreTotal,
} from "@vektorprogrammet/domain/recruitment";
import { createAuthenticatedClient } from "../lib/api.server";
import { requireAuth, expiredSessionRedirect } from "../lib/auth.server";
import { toRecruitmentBridgeFailure } from "../foldkit/recruitment/bridge";
import { Button } from "../components/ui/button";
import type { Route } from "./+types/dashboard.intervjuer.rapport";

const responseHeaders = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;
export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);
  const params = new URL(request.url).searchParams;
  let query: InterviewReportQuery;
  try {
    for (const key of params.keys())
      if (params.getAll(key).length !== 1) throw new Error("duplicate query");
    query = Schema.decodeUnknownSync(InterviewReportQuery)(Object.fromEntries(params), {
      onExcessProperty: "error",
    });
  } catch {
    throw new Response("Ugyldig rapportvalg", { status: 400, headers: responseHeaders });
  }
  try {
    const result = await createAuthenticatedClient(cookie, request).recruitment.readInterviewReport(
      { query },
    );
    const report = Schema.decodeUnknownSync(InterviewReport)(result.body, {
      onExcessProperty: "error",
    });
    return data({ report, failed: false as const, query }, { headers: responseHeaders });
  } catch (error) {
    const failure = toRecruitmentBridgeFailure(error);
    if (failure._tag === "Unauthorized") throw await expiredSessionRedirect(request);
    if (failure._tag === "Forbidden")
      throw new Response("Du har ikke tilgang til denne rapporten.", {
        status: 403,
        headers: responseHeaders,
      });
    return data(
      { report: null, failed: true as const, query },
      { headers: responseHeaders, status: 503 },
    );
  }
}
export const headers = () => ({
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});

const periodLabel = (period: InterviewReport["periods"][number]) =>
  `${new Date(period.startAt).toLocaleDateString("nb-NO", { timeZone: "UTC" })} – ${new Date(period.endAt).toLocaleDateString("nb-NO", { timeZone: "UTC" })}`;
export default function CompletedInterviewReportRoute() {
  const { report, failed, query } = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  const pending = navigation.state !== "idle";
  const selectedPeriod = report?.periods.find((period) => period.id === report.selectedPeriodId);
  const sortHref = (sort: "applicant" | "recommendation" | "total") => {
    const params = new URLSearchParams();
    if (report?.selectedPeriodId) params.set("admissionPeriodId", report.selectedPeriodId);
    params.set("recommendation", report?.recommendation ?? "all");
    params.set("sort", sort);
    params.set("direction", report?.sort === sort && report.direction === "asc" ? "desc" : "asc");
    return `?${params}`;
  };
  const sortState = (sort: string): "ascending" | "descending" | "none" =>
    report?.sort === sort ? (report.direction === "asc" ? "ascending" : "descending") : "none";
  return (
    <section
      className="mx-auto grid w-full max-w-6xl gap-6 p-4"
      aria-labelledby="report-heading"
      aria-busy={pending}
    >
      <header>
        <h1 id="report-heading" className="text-2xl font-semibold">
          Fullførte intervjuer
        </h1>
        <p className="mt-2">Tidligere deltakelse er ikke klassifisert i denne oversikten.</p>
      </header>
      {pending ? (
        <p role="status">Henter rapporten …</p>
      ) : failed ? (
        <div role="alert">
          <p>Rapporten kunne ikke hentes. Prøv igjen.</p>
          <Form method="get">
            {Object.entries(query).map(([key, value]) => (
              <input key={key} type="hidden" name={key} value={value} />
            ))}
            <Button type="submit" className="mt-3">
              Prøv igjen
            </Button>
          </Form>
        </div>
      ) : (
        report && (
          <>
            <Form
              method="get"
              key={`${report.selectedPeriodId}:${report.recommendation}:${report.sort}:${report.direction}`}
              className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
            >
              <div className="grid gap-2">
                <label htmlFor="report-period" className="font-semibold">
                  Opptaksperiode
                </label>
                <select
                  className="min-h-11 w-full rounded-md border bg-background px-3"
                  id="report-period"
                  name="admissionPeriodId"
                  required
                  defaultValue={report.selectedPeriodId ?? ""}
                >
                  <option value="" disabled>
                    Velg opptaksperiode
                  </option>
                  {report.periods.map((period) => (
                    <option key={period.id} value={period.id}>
                      {periodLabel(period)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label htmlFor="report-recommendation" className="font-semibold">
                  Anbefaling
                </label>
                <select
                  className="min-h-11 w-full rounded-md border bg-background px-3"
                  id="report-recommendation"
                  name="recommendation"
                  defaultValue={report.recommendation}
                >
                  <option value="all">Alle anbefalinger</option>
                  <option value="Ja">Ja</option>
                  <option value="Kanskje">Kanskje</option>
                  <option value="Nei">Nei</option>
                  <option value="not-recorded">Ikke registrert</option>
                </select>
              </div>
              <input type="hidden" name="sort" value={report.sort} />
              <input type="hidden" name="direction" value={report.direction} />
              <Button type="submit" disabled={report.periods.length === 0}>
                Vis rapport
              </Button>
            </Form>
            {report.periods.length === 0 ? (
              <p role="status">Avdelingen har ingen opptaksperioder.</p>
            ) : report.selectedPeriodId === null ? (
              <p role="status">Velg en opptaksperiode for å vise fullførte intervjuer.</p>
            ) : (
              <>
                <h2 className="text-lg font-semibold">
                  Opptaksperiode: {selectedPeriod && periodLabel(selectedPeriod)}
                </h2>
                <p role="status">{report.rows.length} fullførte intervjuer</p>
                {report.rows.length === 0 ? (
                  <p>Ingen fullførte intervjuer samsvarer med valgene.</p>
                ) : (
                  <div className="max-w-full overflow-x-auto rounded-lg border">
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">
                        Fullførte intervjuer i valgt opptaksperiode
                      </caption>
                      <thead>
                        <tr className="border-b bg-muted">
                          <th className="p-3" scope="col" aria-sort={sortState("applicant")}>
                            <Link
                              className="inline-flex min-h-11 items-center underline"
                              to={sortHref("applicant")}
                            >
                              Søker
                            </Link>
                          </th>
                          <th className="p-3" scope="col">
                            Fullført
                          </th>
                          <th className="p-3" scope="col" aria-sort={sortState("recommendation")}>
                            <Link
                              className="inline-flex min-h-11 items-center underline"
                              to={sortHref("recommendation")}
                            >
                              Anbefaling
                            </Link>
                          </th>
                          <th className="p-3" scope="col">
                            Forklaringskraft
                          </th>
                          <th className="p-3" scope="col">
                            Rollemodell
                          </th>
                          <th className="p-3" scope="col">
                            Egnethet
                          </th>
                          <th className="p-3" scope="col" aria-sort={sortState("total")}>
                            <Link
                              className="inline-flex min-h-11 items-center underline"
                              to={sortHref("total")}
                            >
                              Sum
                            </Link>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.rows.map((row) => (
                          <tr className="border-b" key={row.interviewId}>
                            <th scope="row" className="p-3 font-medium">
                              {row.firstName} {row.lastName}
                            </th>
                            <td className="p-3">
                              {new Date(row.completedAt).toLocaleString("nb-NO", {
                                timeZone: "Europe/Oslo",
                              })}
                            </td>
                            <td className="p-3">{row.recommendation ?? "Ikke registrert"}</td>
                            <td className="p-3">{row.explanatoryPower}</td>
                            <td className="p-3">{row.roleModel}</td>
                            <td className="p-3">{row.suitability}</td>
                            <td className="p-3">{interviewScoreTotal(row)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </>
        )
      )}
    </section>
  );
}

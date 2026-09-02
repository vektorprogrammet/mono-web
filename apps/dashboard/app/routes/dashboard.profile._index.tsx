import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ChevronRight } from "lucide-react";
import { NavLink, href, useLoaderData } from "react-router";
import { createAuthenticatedClient } from "../lib/api.server";
import { expiredSessionRedirect, loadSessionIdentity, requireAuth } from "../lib/auth.server";
import { projectProfile } from "../lib/profile-view";
import type { Route } from "./+types/dashboard.profile._index";

export async function loader({ request }: Route.LoaderArgs) {
  const cookie = await requireAuth(request);

  const client = createAuthenticatedClient(cookie, request);
  try {
    const result = await client.profile.readOwnProfile({ headers: {} });
    if (result.body === undefined) throw new Error("Profile response did not include a body");
    return {
      profile: projectProfile(result.body),
      identity: null,
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "credential.missing" || code === "credential.invalid") {
      throw await expiredSessionRedirect(request);
    }
    if (code === "authority.denied" || code === "scope.not-found") {
      return {
        profile: null,
        identity: await loadSessionIdentity(request),
      };
    }
    throw new Response(null, { status: 503 });
  }
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Profile() {
  const { profile, identity } = useLoaderData<typeof loader>();
  if (profile === null) {
    if (identity === null) throw new Error("Missing session identity for unavailable profile");
    return (
      <main className="mx-10 mt-10">
        <h1 className="mb-2 font-semibold text-2xl lg:mb-4 lg:text-4xl">{identity.name}</h1>
        <p>
          <a className="text-blue-600 hover:underline" href={`mailto:${identity.email}`}>
            {identity.email}
          </a>
        </p>
        <section className="mt-8 max-w-2xl rounded-lg border bg-gray-50 p-6">
          <h2 className="font-semibold text-xl">Profilopplysningene kunne ikke hentes</h2>
          <p className="mt-2 text-muted-foreground">
            Du er fortsatt innlogget, men organisasjonstilknytningen gir ikke tilgang til den
            fullstendige profilen.
          </p>
        </section>
      </main>
    );
  }
  return (
    <>
      <div className="mx-10 mt-10 flex flex-col">
        <section className="items-center gap-4 lg:mb-8 lg:grid lg:grid-cols-3 lg:flex-row">
          <div className="flex flex-col items-center self-end lg:items-start">
            <h1 className="mb-2 font-semibold text-2xl lg:mb-4 lg:text-4xl">
              {profile.firstName} {profile.lastName}
            </h1>
            <h2 className="font-medium lg:text-xl">{profile.role}</h2>
            <p className="lg:mb-4">
              <a
                href={`mailto:${profile.email}`}
                className="text-blue-600 hover:underline"
              >
                {profile.email}
              </a>
            </p>
          </div>
        </section>
        <div className="gap-8 lg:grid lg:grid-cols-3">
          <div className="col-start-2 col-end-4">
            <h2 className="mt-2 font-semibold text-xl">Aktivitet i Vektorprogrammet</h2>
            <p>Aktivitetshistorikk er ikke tilgjengelig i den nye profiltjenesten ennå.</p>
          </div>
        </div>
        <div className="mb-8 gap-8 lg:grid lg:grid-cols-3 lg:flex-row">
          <div className="col-span-1 mt-8 lg:mt-0">
            <div className="flex flex-col">
              <Button
                asChild
                className="flex flex-row justify-between rounded-t-lg bg-gray-50 px-4 py-2 text-left font-medium text-black hover:bg-gray-100"
              >
                <NavLink to={href("/profile/rediger")} prefetch="intent">
                  Rediger profil
                  <ChevronRight />
                </NavLink>
              </Button>
              <Button
                type="button"
                className="flex flex-row justify-between rounded-b-lg bg-gray-50 px-4 py-2 text-left font-medium text-black hover:bg-gray-100"
              >
                Bytt passord
                <ChevronRight />
              </Button>
            </div>
            <Table className="mt-8 w-full table-fixed border-separate rounded-lg bg-gray-50">
              <TableBody>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">Avdeling:</TableCell>
                  <TableCell className="truncate">
                    Ikke tilgjengelig
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">Telefon:</TableCell>
                  <TableCell className="truncate">{profile.phone ?? "Ikke oppgitt"}</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell className="w-2/5 font-medium">E-post:</TableCell>
                  <TableCell className="truncate">
                    <a className="text-blue-600 hover:underline" href={`mailto:${profile.email}`}>
                      {profile.email}
                    </a>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
      </div>
    </>
  );
}

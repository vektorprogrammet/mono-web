export async function loader() {
  return { available: false as const };
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export
export default function Sponsorer() {
  return (
    <section className="mx-auto mt-10 max-w-2xl rounded-lg border bg-gray-50 p-6" role="status">
      <h1 className="font-semibold text-xl">Sponsoroversikten er ikke tilgjengelig</h1>
      <p className="mt-2 text-muted-foreground">
        Den native tjenesten tilbyr ikke sponsordata ennå.
      </p>
    </section>
  );
}

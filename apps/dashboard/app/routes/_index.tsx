import { Button } from "@/components/ui/button";
import type { LoaderFunction, MetaFunction } from "react-router";
import { Link, href, redirect } from "react-router";

export const clientLoader: LoaderFunction = () => {
  return redirect("/dashboard");
};

export const meta: MetaFunction = () => {
  return [
    { title: "Vektor Dashboard" },
    { name: "description", content: "Welcome to Remix!" },
  ];
};

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Index() {
  return (
    <main className="grid h-dvh place-items-center">
      <Button variant={"default"} asChild>
        <Link to={href("/dashboard")} prefetch="intent">
          Log in
        </Link>
      </Button>
    </main>
  );
}

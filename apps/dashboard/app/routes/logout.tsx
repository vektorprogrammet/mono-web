import { redirect } from "react-router";
import { signOut } from "../lib/auth.server";
import type { Route } from "./+types/logout";

export async function action({ request }: Route.ActionArgs) {
  return redirect("/login", {
    headers: await signOut(request),
  });
}

export async function loader() {
  return redirect("/login");
}

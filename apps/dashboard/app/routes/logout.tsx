import { redirect } from "react-router";
import { createLogoutCookie } from "../lib/auth.server";
import type { Route } from "./+types/logout";

export async function action(_args: Route.ActionArgs) {
  return redirect("/login", {
    headers: { "Set-Cookie": createLogoutCookie() },
  });
}

export async function loader() {
  return redirect("/login");
}

import { href } from "react-router";

export const dashboardLoginUrl = import.meta.env.HOMEPAGE_DASHBOARD_LOGIN_URL;

export const navRoutes = [
  { path: href("/"), name: "Hjem" },
  { path: href("/om-oss"), name: "Om oss" },
  { path: href("/assistenter"), name: "Assistenter" },
  { path: href("/team"), name: "Team" },
  { path: href("/foreldre"), name: "Foreldre" },
  { path: href("/skoler"), name: "Skoler" },
  { path: href("/nyheter"), name: "Nyheter" },
  { path: href("/kontakt"), name: "Kontakt" },
];

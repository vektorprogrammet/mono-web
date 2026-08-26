import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { SiFacebook } from "@icons-pack/react-simple-icons";
import { FolderOpen, Mail, MapPin } from "lucide-react";
import { motion } from "motion/react";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, type To, useLocation, useLoaderData } from "react-router";
import { Button, buttonVariants } from "~/components/ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTrigger,
} from "~/components/ui/drawer";
import { BUILD_COMMIT, BUILD_CONTENT_DIGEST, BUILD_ROUTE_DIGEST } from "~/lib/build-provenance";
import { DEV_CONTENT, DEV_CONTENT_SOURCE } from "~/lib/dev-content";
import { resolveHomepageRequest, type HomepageRequest } from "~/lib/host";
import "~/home.css";
import { navRoutes } from "~/nav-routes";

type HomeLoaderArgs = {
  request: Request;
};

export function loader({ request }: HomeLoaderArgs): HomepageRequest {
  const host = request.headers.get("host");
  if (!host) throw new Response("Missing Host", { status: 421 });
  return resolveHomepageRequest(host);
}

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function Layout() {
  const requestInfo = useLoaderData<typeof loader>();
  return (
    <div className="flex min-h-screen flex-col items-stretch transition-colors">
      <AppHeader />
      <DevContentBanner requestInfo={requestInfo} />
      <Outlet />
      <AppFooter />
    </div>
  );
}

function DevContentBanner({ requestInfo }: { requestInfo: HomepageRequest }) {
  return (
    <aside
      className="mx-auto mt-4 w-[calc(100%-2rem)] max-w-6xl rounded-lg border-2 border-amber-500 bg-amber-100 px-4 py-3 text-center font-semibold text-amber-950 shadow-sm"
      data-testid="dev-content-banner"
    >
      DEV CONTENT · {requestInfo.stage} · {requestInfo.host} · {DEV_CONTENT_SOURCE} · {BUILD_COMMIT}{" "}
      · {BUILD_CONTENT_DIGEST} · {BUILD_ROUTE_DIGEST}
    </aside>
  );
}

function AppHeader() {
  return (
    <div className="sticky top-2 z-50">
      <div className="hidden w-full flex-wrap justify-center md:flex lg:px-4">
        <div className="mr-12 flex w-fit items-center gap-1 rounded-full bg-[#ccecf6] bg-opacity-40 px-1.5 shadow-md backdrop-blur dark:bg-black dark:bg-opacity-40">
          <img
            src="/images/vektor-logo-circle.svg"
            alt="vektorprogrammet logo"
            width={32}
            height={32}
          />
          <NavTabs routes={navRoutes} />
        </div>
      </div>
      <div className="absolute top-0 right-2 hidden rounded-full md:flex">
        <LoginButtons />
      </div>
      <MobileMenu routes={navRoutes} />
    </div>
  );
}

function NavTabs({ routes }: { routes: Array<{ name: string; path: To }> }) {
  const location = useLocation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef(new Map<string, HTMLAnchorElement>());
  const [indicator, setIndicator] = useState<{
    x: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const pathname = location.pathname;
    const activeKey = routes
      .find((route) => {
        const routePath = route.path.toString();
        return pathname === routePath || pathname.startsWith(`${routePath}/`);
      })
      ?.path.toString();

    if (!activeKey) {
      setIndicator(null);
      return;
    }

    const activeEl = tabRefs.current.get(activeKey);
    if (!activeEl) return;

    const containerRect = container.getBoundingClientRect();
    const activeRect = activeEl.getBoundingClientRect();
    setIndicator({
      x: activeRect.left - containerRect.left,
      width: activeRect.width,
    });
  }, [location.pathname, routes]);

  return (
    <div ref={containerRef} className="flew-row relative mx-auto flex h-11 rounded-full px-0.5">
      {indicator && (
        <motion.div
          className="absolute top-1.5 bottom-1.5 rounded-full bg-vektor-blue mix-blend-multiply shadow-sm"
          animate={{ x: indicator.x, width: indicator.width }}
          transition={{ type: "spring", bounce: 0.1, duration: 0.6 }}
        />
      )}
      {routes.map((route) => {
        const routeKey = route.path.toString();
        return (
          <NavLink
            to={route.path}
            key={routeKey}
            className={({ isActive }) =>
              `${isActive ? "text-black" : "text-neutral-700 hover:text-black"} relative my-1.5 place-content-center px-4 py-auto text-center font-medium text-sm`
            }
            prefetch="intent"
            ref={(node) => {
              if (node) {
                tabRefs.current.set(routeKey, node);
              } else {
                tabRefs.current.delete(routeKey);
              }
            }}
          >
            {route.name}
          </NavLink>
        );
      })}
    </div>
  );
}

function LoginButtons() {
  return (
    <div className="flex space-x-4 overflow-clip rounded-full">
      <Link
        className={buttonVariants({ variant: "green" })}
        to={"/kontrollpanel"}
        prefetch="intent"
      >
        {"Logg inn"}
      </Link>
    </div>
  );
}

const MobileMenu = ({ routes }: { routes: Array<{ name: string; path: To }> }) => {
  return (
    <div className="md:hidden">
      <Drawer>
        <DrawerTrigger asChild>
          <Button
            variant="outline"
            className="fixed top-12 right-0 flex rounded-l-full bg-[rgba(0,0,0,0.8)] p-1 pr-2"
            size="icon"
          >
            <Avatar className="h-full w-full rounded-full">
              <AvatarImage src="/images/team/IT-Tor.png" />
              <AvatarFallback>{"Tor"}</AvatarFallback>
            </Avatar>
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader />
          <DrawerDescription>
            <div className="flex items-start justify-between p-6">
              <ul className="flex w-full flex-col items-start gap-4 text-center">
                {routes.map((route) => (
                  <li key={route.name}>
                    <Link
                      className="text-lg dark:text-white"
                      reloadDocument
                      to={route.path}
                      prefetch="render"
                    >
                      {route.name}
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex w-fit justify-center">
                <LoginButtons />
              </div>
            </div>
          </DrawerDescription>
          <DrawerFooter>
            <DrawerClose>
              <Button variant="outline">{"Lukk"}</Button>
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    </div>
  );
};

function AppFooter() {
  return (
    <footer className="bg-vektor-DARKblue">
      <div className="mx-auto flex max-w-6xl flex-col place-items-center justify-between space-y-8 p-2 py-8 lg:flex-row lg:space-x-4 lg:space-y-0">
        <img
          src="/images/vektor-logo-white.svg"
          alt="vektorprogrammet logo hvit"
          className="h-24 md:h-40"
        />
        <FooterLinks />
        <FooterSponsors />
      </div>
    </footer>
  );
}

function FooterSponsors() {
  return (
    <ul className="text-white">
      <b>
        <li>{"Sponsorer og samarbeidspartnere (DEV CONTENT)"}</li>
      </b>
      {DEV_CONTENT.sponsors.map((sponsor) => (
        <li key={sponsor.id}>
          <a className="text-sm hover:underline" href={sponsor.href}>
            {sponsor.name}
          </a>
        </li>
      ))}
    </ul>
  );
}

function FooterLinks() {
  return (
    <div className="text-white">
      <ul className="grid grid-cols-1 gap-8">
        <li className="flex place-items-center space-x-4">
          <SiFacebook size={40} />
          <ul className="flex place-items-center space-x-2">
            <li>
              <a className="hover:underline" href="https://www.facebook.com/vektorprogrammet/">
                {"Trondheim"}
              </a>
            </li>

            <li>
              <a className="hover:underline" href="https://www.facebook.com/vektorprogrammetNMBU/">
                {"Ås"}
              </a>
            </li>

            <li>
              <a
                className="hover:underline"
                href="https://www.facebook.com/VektorprogrammetBergen/"
              >
                {"Bergen"}
              </a>
            </li>
          </ul>
        </li>

        <li className="flex place-items-center space-x-4">
          <Mail size={40} />
          <div className="flex place-items-center space-x-2">
            <a className="hover:underline" href="mailto:hovedstyret@example.invalid">
              {"hovedstyret@example.invalid"}
            </a>
          </div>
        </li>

        <li className="flex place-items-center space-x-4">
          <MapPin size={40} />
          <div className="flex place-items-center space-x-2">{"DEV CONTENT, Trondheim"}</div>
        </li>

        <li className="flex place-items-center space-x-4">
          <FolderOpen size={40} />
          <div className="flex place-items-center space-x-2">
            {"Non-production development surface"}
          </div>
        </li>
      </ul>
    </div>
  );
}

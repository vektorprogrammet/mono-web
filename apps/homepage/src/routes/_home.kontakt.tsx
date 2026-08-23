import { Outlet } from "react-router";

// biome-ignore lint/style/noDefaultExport: Route Modules require default export https://reactrouter.com/start/framework/route-module
export default function KontaktLayout() {
  return (
    <div className="mx-auto mt-10 mb-20 flex max-w-6xl flex-col items-center">
      <header className="mx-auto flex w-full flex-col px-5">
        <h1 className="font-bold text-4xl text-gray-600 dark:text-gray-200">Kontakt oss</h1>
        <p className="mt-4 mb-10 max-w-2xl text-xl dark:text-gray-300">
          Velg avdelingen du vil kontakte. Vi svarer på e-post så snart vi kan.
        </p>
      </header>
      <Outlet />
    </div>
  );
}

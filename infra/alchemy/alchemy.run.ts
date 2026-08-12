import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { homepageDomain } from "../../apps/homepage/src/lib/host.ts";

export { homepageDomain };

export default Alchemy.Stack(
  "MonoWebHomepage",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const domain = homepageDomain(stage);
    console.info(`[MonoWebHomepage] stage=${stage} domain=${domain}`);

    const homepage = yield* Cloudflare.Website.Vite("Homepage", {
      rootDir: "../../apps/homepage",
      main: "workers/app.ts",
      domain,
      workersDev: false,
      assets: { runWorkerFirst: true },
    });

    return { url: homepage.url.as<string>() };
  }),
);

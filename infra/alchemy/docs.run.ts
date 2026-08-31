import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import { DOCS_IDENTITY } from "./docs/identity.ts";

export default Alchemy.Stack(
  DOCS_IDENTITY.stack,
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    if (stage !== DOCS_IDENTITY.stage && stage !== "placeholder") {
      throw new Error(`docs stack accepts only stage ${DOCS_IDENTITY.stage}`);
    }
    const build = yield* Command.Build("DocsBuild", {
      command: "bun run build",
      cwd: "../../apps/docs",
      outdir: "dist/public",
      memo: {
        include: [
          "**/*",
          "../../design-specs/**/*.md",
          "../../evidence/**/*",
          "../../STATE.md",
          "../../apps/backend/src/**/*",
          "../../apps/dashboard/app/**/*",
          "../../packages/**/*",
        ],
        lockfile: true,
      },
    });

    const site = yield* Cloudflare.Worker(DOCS_IDENTITY.logicalId, {
      name: DOCS_IDENTITY.workerName,
      assets: {
        directory: build.outdir,
        hash: build.hash.output.as<string>(),
        htmlHandling: "auto-trailing-slash",
        notFoundHandling: "404-page",
      },
      workersDev: false,
      domain: DOCS_IDENTITY.hostname,
      observability: { enabled: false },
    });

    return {
      stack: DOCS_IDENTITY.stack,
      stage,
      hostname: DOCS_IDENTITY.hostname,
      url: site.url.as<string>(),
      workerName: DOCS_IDENTITY.workerName,
      stateNamespace: DOCS_IDENTITY.stateNamespace,
    };
  }),
);

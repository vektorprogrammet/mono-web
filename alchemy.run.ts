import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "MonoWebPreview",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const worker = yield* Cloudflare.Worker("PreviewSpine", {
      main: "./infra/preview.worker.ts",
      workersDev: { enabled: true, previewsEnabled: false },
    });

    return { url: worker.url.as<string>() };
  }),
);

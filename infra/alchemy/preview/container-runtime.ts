import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { PreviewContainer } from "./container.ts";

/** Runtime registration for the externally built Symfony+MariaDB image. */
export default Cloudflare.Containers.layer(PreviewContainer, {
  enableInternet: false,
});

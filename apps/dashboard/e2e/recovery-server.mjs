import { createRequestHandler } from "react-router";
import * as build from "../build/server/index.js";
const handler = createRequestHandler(build, "production");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/")) {
      const file = Bun.file(new URL(`../build/client${path}`, import.meta.url));
      if (await file.exists()) return new Response(file);
      return new Response(null, { status: 404 });
    }
    return handler(request);
  },
});
process.stdout.write(`Recovery rehearsal dashboard listening on ${server.port}\n`);

import { createRequestHandler } from "react-router";
import * as build from "../build/server/index.js";
const handler = createRequestHandler(build, "production");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch: (request) => handler(request),
});
process.stdout.write(`Recovery rehearsal dashboard listening on ${server.port}\n`);

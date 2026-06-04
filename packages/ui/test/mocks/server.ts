import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);

server.events.on("request:unhandled", ({ request }) => {
  console.error("Unhandled %s %s", request.method, request.url);
});

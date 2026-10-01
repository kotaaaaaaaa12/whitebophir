import {
  Container,
  ContainerProxy,
  getContainer,
} from "@cloudflare/containers";
export { ContainerProxy };
export { WhiteboardStorage } from "./storage";

export class WhiteboardContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    NODE_ENV: "production",
    PORT: "8080",
    HOST: "0.0.0.0",
    WBO_HISTORY_DIR: "/opt/app/server-data",
    WBO_CLOUD_STORAGE_URL: "http://wbo.storage",
    WBO_IP_SOURCE: "CF-Connecting-IP",
    WBO_SAVE_INTERVAL: "2000",
    WBO_MAX_SAVE_DELAY: "10000",
    ...(this.env.AUTH_SECRET_KEY
      ? { AUTH_SECRET_KEY: this.env.AUTH_SECRET_KEY }
      : {}),
    ...(this.env.WBO_BOARD_MODERATORS
      ? { WBO_BOARD_MODERATORS: this.env.WBO_BOARD_MODERATORS }
      : {}),
    ...(this.env.TURNSTILE_SITE_KEY
      ? { TURNSTILE_SITE_KEY: this.env.TURNSTILE_SITE_KEY }
      : {}),
    ...(this.env.TURNSTILE_SECRET_KEY
      ? { TURNSTILE_SECRET_KEY: this.env.TURNSTILE_SECRET_KEY }
      : {}),
  };

  async onStart(): Promise<void> {
    console.log(JSON.stringify({ event: "whiteboard.container.started" }));
  }

  async onStop(): Promise<void> {
    console.log(JSON.stringify({ event: "whiteboard.container.stopped" }));
  }
}

WhiteboardContainer.outboundByHost = {
  "wbo.storage": (request, env: Env) =>
    env.STORAGE.getByName("boards-v1").fetch(request),
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === "/__health") {
      return Response.json({
        ready: true,
        persistence: "R2 and Durable Objects",
      });
    }
    // All rooms use one instance, including Engine.IO's polling and upgrade.
    // This prevents split boards when users join through different locations.
    const container = getContainer(env.WHITEBOARD, "whiteboard-v1");
    try {
      await container.startAndWaitForPorts({
        cancellationOptions: { portReadyTimeoutMS: 180_000 },
      });
      const headers = new Headers(request.headers);
      // Use the edge-derived IP rather than a user-supplied forwarded header.
      headers.set(
        "CF-Connecting-IP",
        request.headers.get("CF-Connecting-IP") || "unknown",
      );
      return await container.fetch(new Request(request, { headers }));
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "whiteboard.request_failed",
          error: String(error),
        }),
      );
      return new Response(
        "The whiteboard is starting or temporarily unavailable. Please try again.",
        {
          status: 503,
          headers: { "retry-after": "5", "cache-control": "no-store" },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;

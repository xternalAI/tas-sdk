import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createStudioApi, type StudioContext } from "./api.ts";
import { studioPage } from "./page.ts";

/**
 * The studio's HTTP server: serves the page and puts the API behind three checks, because it
 * can write files and call your platform with your credentials.
 *
 * 1. It listens on the loopback address only, so nothing off this machine can reach it.
 * 2. It answers only when the Host header is that loopback address, which stops a web page from
 *    reaching it through a domain name it has pointed at 127.0.0.1 (DNS rebinding).
 * 3. Every API call must carry a token that exists only in the page this server served, so
 *    another site open in the same browser cannot drive it.
 */

export interface StudioOptions {
  /** Default 4983. Use 0 to let the system pick a free port. */
  port?: number;
}

export interface Studio {
  url: string;
  /** The session token the page sends. Exposed for tests and for scripting against the API. */
  token: string;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 2_000_000;
const HOST = "127.0.0.1";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
}

export async function startStudio(context: StudioContext, options: StudioOptions = {}): Promise<Studio> {
  const api = createStudioApi(context);
  const token = randomBytes(24).toString("hex");
  let allowedHosts = new Set<string>();

  const server: Server = createServer(async (request, response) => {
    const send = (status: number, type: string, body: string) => {
      response.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(body);
    };
    const json = (status: number, body: unknown) => send(status, "application/json; charset=utf-8", JSON.stringify(body));
    try {
      if (!allowedHosts.has(request.headers.host ?? ""))
        return json(403, { error: "this server only answers on its own loopback address" });
      const path = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
      if (request.method === "GET" && path === "/") return send(200, "text/html; charset=utf-8", studioPage(token));
      if (!path.startsWith("/api/")) return json(404, { error: "not found" });
      if (request.headers["x-tas-token"] !== token) return json(401, { error: "missing or wrong session token; reload the studio page" });
      const body = request.method === "GET" ? undefined : await readJson(request);
      const result = await api({ method: request.method ?? "GET", path, body });
      return json(result.status, result.body);
    } catch (error) {
      return json(400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 4983, HOST, resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 4983);
  allowedHosts = new Set([`${HOST}:${port}`, `localhost:${port}`]);

  return {
    url: `http://${HOST}:${port}`,
    token,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

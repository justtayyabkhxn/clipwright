import http from "node:http";
import type { AddressInfo } from "node:net";

export type FakeServer = { url: string; calls: string[]; close: () => Promise<void> };
export type Handler = (
  request: http.IncomingMessage,
  body: Buffer,
  url: URL,
) => { status?: number; json: unknown; headers?: Record<string, string> };

/** A tiny JSON server on 127.0.0.1 and a free port. Every request is logged as "METHOD /path". */
export async function startJsonServer(name: string, handle: Handler): Promise<FakeServer> {
  const calls: string[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake");
      calls.push(`${request.method} ${url.pathname}`);
      let status = 500;
      let payload: unknown;
      let headers: Record<string, string> = {};
      try {
        ({ status = 200, json: payload, headers = {} } = handle(request, Buffer.concat(chunks), url));
      } catch (error) {
        payload = { type: "error", error: { type: "api_error", message: String(error) } };
        console.error(`[fake ${name}]`, error);
      }
      response.writeHead(status, { "content-type": "application/json", "request-id": `req_${calls.length}`, ...headers });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

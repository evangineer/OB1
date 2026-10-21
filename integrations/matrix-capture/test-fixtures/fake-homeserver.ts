// Test fixture: a minimal Matrix homeserver on node:http, enough for createClient + initRustCrypto + startClient.
// /sync is driven by the test: each request waits for the next queued response.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeRequest = { method: string; path: string };
export type FakeResponse = { status?: number; body: unknown };
/** Keyed by a regex source matched against `"<METHOD> <path>"`, e.g. `"GET /room_keys/version$"`. */
export type FakeHandlers = Record<string, (req: FakeRequest & { body: unknown }) => FakeResponse>;

export type FakeHomeserver = {
  url: string;
  requests: FakeRequest[];
  /** Queue the body of the next /sync response. */
  queueSync(body: unknown): void;
  /** Resolves once `count` requests whose path matches `pattern` have been received. */
  waitForRequests(pattern: RegExp, count: number): Promise<void>;
  close(): Promise<void>;
};

export async function startFakeHomeserver(
  handlers: FakeHandlers = {},
  identity: { userId: string; deviceId: string } = { userId: "@bot:localhost", deviceId: "TESTDEV" },
): Promise<FakeHomeserver> {
  const requests: FakeRequest[] = [];
  const syncQueue: unknown[] = [];
  const syncWaiters: Array<(body: unknown) => void> = [];
  const requestWaiters: Array<{ pattern: RegExp; count: number; resolve: () => void }> = [];
  let uploadedOtks = 0;
  let closed = false;

  const nextSync = (): Promise<unknown> =>
    syncQueue.length > 0 ? Promise.resolve(syncQueue.shift()) : new Promise((r) => syncWaiters.push(r));

  const checkWaiters = () => {
    for (const w of [...requestWaiters]) {
      if (requests.filter((r) => w.pattern.test(r.path)).length >= w.count) {
        requestWaiters.splice(requestWaiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };

  const readBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    if (chunks.length === 0) return undefined;
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return undefined;
    }
  };

  const defaultRoute = async (method: string, path: string, body: unknown): Promise<FakeResponse> => {
    if (/\/versions$/.test(path)) {
      return { body: { versions: ["v1.1", "v1.5", "v1.11"], unstable_features: {} } };
    }
    if (/\/account\/whoami$/.test(path)) return { body: { user_id: identity.userId, device_id: identity.deviceId } };
    if (method === "POST" && /\/user\/[^/]+\/filter$/.test(path)) return { body: { filter_id: "1" } };
    if (/\/pushrules\/?$/.test(path)) return { body: { global: {} } };
    if (/\/capabilities$/.test(path)) return { body: { capabilities: {} } };
    if (/\/keys\/query$/.test(path)) return { body: { device_keys: {}, failures: {} } };
    if (/\/keys\/upload$/.test(path)) {
      const otks = (body as { one_time_keys?: Record<string, unknown> } | undefined)?.one_time_keys ?? {};
      uploadedOtks += Object.keys(otks).length;
      return { body: { one_time_key_counts: { signed_curve25519: uploadedOtks } } };
    }
    if (/\/room_keys\/version$/.test(path)) {
      return { status: 404, body: { errcode: "M_NOT_FOUND", error: "No current backup version" } };
    }
    if (/\/sync$/.test(path)) return { body: await nextSync() };
    return { body: {} };
  };

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    requests.push({ method, path });
    checkWaiters();
    const body = await readBody(req);
    let response: FakeResponse;
    const key = `${method} ${path}`;
    const custom = Object.keys(handlers).find((k) => new RegExp(k).test(key));
    response = custom ? handlers[custom]!({ method, path, body }) : await defaultRoute(method, path, body);
    if (closed || res.destroyed) return;
    res.writeHead(response.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response.body ?? {}));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    queueSync(body) {
      const waiter = syncWaiters.shift();
      if (waiter) waiter(body);
      else syncQueue.push(body);
    },
    waitForRequests(pattern, count) {
      return new Promise<void>((resolve) => {
        requestWaiters.push({ pattern, count, resolve });
        checkWaiters();
      });
    },
    async close() {
      closed = true;
      // Release /sync handlers still waiting; their responses are dropped.
      for (const w of syncWaiters.splice(0)) w({});
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

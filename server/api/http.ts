import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { integerSetting, type Environment } from "../runtime/config";
export type TransferPolicy = {
  totalMs: number;
  idleMs: number;
  bodyBytes: number;
};
export function httpConfiguration(env: Environment) {
  return {
    headersMs: integerSetting(env, "VIDEO_HTTP_HEADERS_MS", 10000, 1, 60000),
    control: {
      totalMs: integerSetting(env, "VIDEO_HTTP_CONTROL_MS", 30000),
      idleMs: integerSetting(env, "VIDEO_HTTP_CONTROL_IDLE_MS", 30000),
      bodyBytes: 1024 * 1024,
    },
    chunk: {
      totalMs: integerSetting(env, "VIDEO_HTTP_CHUNK_MS", 180000),
      idleMs: integerSetting(env, "VIDEO_HTTP_CHUNK_IDLE_MS", 30000),
      bodyBytes: integerSetting(
        env,
        "VIDEO_HTTP_CHUNK_BYTES",
        4 * 1024 * 1024,
        1,
        64 * 1024 * 1024,
      ),
    },
    download: {
      totalMs: integerSetting(
        env,
        "VIDEO_HTTP_DOWNLOAD_MS",
        900000,
        1,
        86400000,
      ),
      idleMs: integerSetting(env, "VIDEO_HTTP_DOWNLOAD_IDLE_MS", 60000),
      bodyBytes: 0,
    },
  };
}
class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
async function untilAborted<T>(
  signal: AbortSignal,
  operation: Promise<T>,
): Promise<T> {
  let stopped: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        stopped = () => reject(new HttpFailure(408, "HTTP_ABORTED"));
        signal.addEventListener("abort", stopped, { once: true });
        if (signal.aborted) stopped();
      }),
    ]);
  } finally {
    if (stopped) signal.removeEventListener("abort", stopped);
  }
}
/** Only server-owned route classification may select a binary policy. Defaults remain JSON control. */
export function createHttpServer(
  handler: (request: Request) => Promise<Response>,
  config = httpConfiguration({}),
  policyFor: (request: IncomingMessage) => TransferPolicy = () =>
    config.control,
) {
  const active = new Set<AbortController>();
  const server = createServer(
    {
      headersTimeout: config.headersMs,
      requestTimeout: Math.max(
        config.headersMs,
        config.control.totalMs,
        config.chunk.totalMs,
        config.download.totalMs,
      ),
      connectionsCheckingInterval: Math.min(config.headersMs, 1000),
    },
    (incoming, outgoing) => {
      void bridge(incoming, outgoing);
    },
  );
  async function bridge(incoming: IncomingMessage, outgoing: ServerResponse) {
    const controller = new AbortController();
    active.add(controller);
    let total: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let body: Readable | undefined;
    let input: Readable | undefined;
    const abort = () => controller.abort();
    const disconnected = () => {
      if (!outgoing.writableFinished) abort();
    };
    const fail = (status: number, code: string) => {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
          connection: "close",
        });
        outgoing.end(JSON.stringify({ error: { code } }));
      } else outgoing.destroy();
      abort();
    };
    incoming.once("aborted", abort);
    outgoing.once("close", disconnected);
    try {
      const policy = policyFor(incoming);
      if (
        ![policy.totalMs, policy.idleMs].every(
          (v) => Number.isSafeInteger(v) && v > 0 && v <= 86400000,
        ) ||
        !Number.isSafeInteger(policy.bodyBytes) ||
        policy.bodyBytes < 0 ||
        policy.bodyBytes > 64 * 1024 * 1024
      )
        throw Error("Invalid transfer policy");
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => fail(408, "HTTP_IDLE_TIMEOUT"), policy.idleMs);
      };
      total = setTimeout(() => fail(408, "HTTP_TOTAL_TIMEOUT"), policy.totalMs);
      touch();
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined)
          headers.set(name, Array.isArray(value) ? value.join(",") : value);
      const init: RequestInit & { duplex?: "half" } = {
        method: incoming.method,
        headers,
        signal: controller.signal,
      };
      if (!["GET", "HEAD"].includes(incoming.method ?? "GET")) {
        const length = headers.get("content-length");
        if (
          length &&
          (!/^\d+$/.test(length) || Number(length) > policy.bodyBytes)
        )
          throw new HttpFailure(413, "BODY_TOO_LARGE");
        let received = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.byteLength;
            touch();
            callback(
              received > policy.bodyBytes
                ? new HttpFailure(413, "BODY_TOO_LARGE")
                : null,
              chunk,
            );
          },
        });
        // pipe (rather than pipeline) leaves the socket writable for a bounded JSON error response.
        input = incoming.pipe(bounded);
        input.on("error", (error) => {
          if (error instanceof HttpFailure) fail(error.status, error.code);
        });
        init.body = Readable.toWeb(input) as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      // A deadline must also release this bridge if a handler ignores its signal.
      const response = await untilAborted(
        controller.signal,
        Promise.resolve()
          .then(() =>
            handler(
              new Request(`http://video-api.invalid${incoming.url}`, init),
            ),
          )
          .then((value) => {
            if (controller.signal.aborted)
              void value.body?.cancel().catch(() => undefined);
            return value;
          }),
      );
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        return;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (
        incoming.method === "HEAD" ||
        [204, 205, 304].includes(response.status) ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => undefined);
        outgoing.end();
      } else {
        body = Readable.fromWeb(
          response.body as import("node:stream/web").ReadableStream,
        );
        const activity = new Transform({
          transform(chunk, _encoding, callback) {
            touch();
            callback(null, chunk);
          },
        });
        await untilAborted(
          controller.signal,
          pipeline(body, activity, outgoing, { signal: controller.signal }),
        );
      }
    } catch (error) {
      if (!controller.signal.aborted)
        fail(
          error instanceof HttpFailure ? error.status : 500,
          error instanceof HttpFailure ? error.code : "INTERNAL_ERROR",
        );
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
      incoming.removeListener("aborted", abort);
      outgoing.removeListener("close", disconnected);
      incoming.unpipe();
      input?.destroy();
      body?.destroy();
      active.delete(controller);
      if (!incoming.complete && !outgoing.destroyed)
        outgoing.once("finish", () => incoming.destroy());
    }
  }
  server.keepAliveTimeout = 5000;
  return {
    server,
    abort: () => {
      for (const c of active) c.abort();
      server.closeAllConnections();
    },
  };
}

import { afterEach, expect, it } from "vitest";
import { request, get } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createHttpServer, httpConfiguration } from "../api/http";
import { jsonBody } from "../api/app";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
async function serve(
  handler: (request: Request) => Promise<Response>,
  config = httpConfiguration({}),
  policy?: Parameters<typeof createHttpServer>[2],
) {
  const bridge = createHttpServer(handler, config, policy);
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  const address = bridge.server.address();
  if (!address || typeof address === "string") throw Error();
  cleanups.push(async () => {
    bridge.abort();
    await new Promise<void>((resolve) => bridge.server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}
it("preserves JSON response status, headers and exact binary bytes without text conversion", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 1, 10, 13]);
  const url = await serve(async (r) =>
    r.url.endsWith("/json")
      ? Response.json({ ok: true }, { status: 202 })
      : new Response(bytes, { headers: { "content-type": "video/mp4" } }),
  );
  const json = await fetch(url + "/json");
  expect(json.status).toBe(202);
  expect(await json.json()).toEqual({ ok: true });
  expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(bytes);
});
it("does not send a HEAD body and cancels it; handles 204 and 304", async () => {
  let cancelled = false;
  const url = await serve(async (r) =>
    r.method === "HEAD"
      ? new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
        )
      : new Response(null, {
          status: Number(new URL(r.url).pathname.slice(1)),
        }),
  );
  expect(await (await fetch(url, { method: "HEAD" })).text()).toBe("");
  expect(cancelled).toBe(true);
  for (const status of [204, 304]) {
    const r = await fetch(url + "/" + status);
    expect(r.status).toBe(status);
    expect(await r.text()).toBe("");
  }
});
it("honors downstream backpressure instead of consuming a full stream", async () => {
  let produced = 0,
    cancelled = false;
  const url = await serve(
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            produced++;
            c.enqueue(new Uint8Array(64 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const req = get(url);
  await new Promise<void>((resolve) =>
    req.on("response", (res) => {
      res.pause();
      setTimeout(() => {
        expect(produced).toBeLessThan(1000);
        req.destroy();
        resolve();
      }, 100);
    }),
  );
  for (let n = 0; n < 30 && !cancelled; n++) await delay(10);
  expect(cancelled).toBe(true);
});
it("streams the first bytes before a slow producer finishes", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const url = await serve(
    async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new Uint8Array([1]));
            await gate;
            c.enqueue(new Uint8Array([2]));
            c.close();
          },
        }),
      ),
  );
  const reader = (await fetch(url)).body!.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  release();
  expect((await reader.read()).value).toEqual(new Uint8Array([2]));
  expect((await reader.read()).done).toBe(true);
});
it("aborts the request signal and upstream body on response disconnect", async () => {
  let aborted = false,
    cancelled = false;
  const url = await serve(async (r) => {
    r.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array([1]));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  });
  await new Promise<void>((resolve) => {
    const req = get(url, (res) =>
      res.once("data", () => {
        req.destroy();
        resolve();
      }),
    );
  });
  for (let n = 0; n < 30 && !cancelled; n++) await delay(10);
  expect(aborted).toBe(true);
  expect(cancelled).toBe(true);
});
it("propagates a partial request disconnect without leaking a handler", async () => {
  let aborted = false;
  const url = await serve(async (r) => {
    r.signal.addEventListener("abort", () => {
      aborted = true;
    });
    await r.text();
    return Response.json({});
  });
  const port = Number(new URL(url).port);
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write(
    "POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx",
  );
  await delay(30);
  socket.destroy();
  for (let n = 0; n < 30 && !aborted; n++) await delay(10);
  expect(aborted).toBe(true);
});
it("does not turn normal request/response completion into abort", async () => {
  let aborted = false;
  const url = await serve(async (r) => {
    r.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return Response.json({ body: await r.text() });
  });
  expect(
    await (await fetch(url, { method: "POST", body: "hello" })).json(),
  ).toEqual({ body: "hello" });
  await delay(20);
  expect(aborted).toBe(false);
});
it("closes an errored response after headers, without sending a second header block", async () => {
  const url = await serve(
    async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new Uint8Array([1]));
            await delay(30);
            c.error(Error("private secret"));
          },
        }),
      ),
  );
  const r = await fetch(url);
  expect(r.status).toBe(200);
  await expect(r.arrayBuffer()).rejects.toThrow();
});
it("enforces actual chunked input size and keeps the JSON parser limit", async () => {
  const policy = { totalMs: 1000, idleMs: 1000, bodyBytes: 8 };
  const url = await serve(
    async (r) => {
      await r.text();
      return Response.json({});
    },
    httpConfiguration({}),
    () => policy,
  );
  const status = await new Promise<number>((resolve) => {
    const req = request(
      url,
      { method: "POST", headers: { "transfer-encoding": "chunked" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", () => {});
    req.write("12345");
    req.end("67890");
  });
  expect(status).toBe(413);
  await expect(
    jsonBody(
      new Request("http://test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: " ".repeat(1024 * 1024 + 1),
      }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  await expect(
    jsonBody(
      new Request("http://test", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: "x",
      }),
    ),
  ).rejects.toMatchObject({ status: 415 });
});
it("supports a server-classified binary input policy without JSON parsing", async () => {
  const bytes = Uint8Array.from([0, 255, 128]);
  const config = httpConfiguration({});
  const url = await serve(
    async (r) => new Response(r.body),
    config,
    () => config.chunk,
  );
  expect(
    new Uint8Array(
      await (await fetch(url, { method: "POST", body: bytes })).arrayBuffer(),
    ),
  ).toEqual(bytes);
});
it("bounds both an idle upload and a handler that ignores cancellation", async () => {
  let aborted = false;
  const config = httpConfiguration({
    VIDEO_HTTP_CONTROL_MS: "80",
    VIDEO_HTTP_CONTROL_IDLE_MS: "40",
  });
  const url = await serve(async (r) => {
    r.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise<Response>(() => {});
  }, config);
  const r = await fetch(url);
  expect(r.status).toBe(408);
  expect(aborted).toBe(true);
  const result = await new Promise<number>((resolve) => {
    const req = request(
      url,
      { method: "POST", headers: { "content-length": "100" } },
      (res) => {
        res.resume();
        resolve(res.statusCode!);
      },
    );
    req.on("error", () => {});
    req.write("x");
  });
  expect(result).toBe(408);
});

it("enforces total lifetime even while the producer is active", async () => {
  let cancelled = false;
  const config = httpConfiguration({
    VIDEO_HTTP_CONTROL_MS: "120",
    VIDEO_HTTP_CONTROL_IDLE_MS: "80",
  });
  const url = await serve(
    async () =>
      new Response(
        new ReadableStream({
          async pull(c) {
            await delay(10);
            c.enqueue(new Uint8Array([1]));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    config,
  );
  const response = await fetch(url);
  await expect(response.arrayBuffer()).rejects.toThrow();
  expect(cancelled).toBe(true);
});
it("bounds a client that never completes its HTTP headers", async () => {
  const url = await serve(
    async () => Response.json({}),
    httpConfiguration({ VIDEO_HTTP_HEADERS_MS: "30" }),
  );
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  let data = "";
  socket.on("data", (b) => {
    data += b;
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  socket.write("POST / HTTP/1.1\r\nHost: localhost\r\n");
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  expect(data).toContain("408");
});

it("does not wait forever for a noncooperative HEAD cancellation callback", async () => {
  let cancelled = false;
  const url = await serve(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise<void>(() => {});
          },
        }),
      ),
  );
  expect(
    (await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1000) }))
      .status,
  ).toBe(200);
  expect(cancelled).toBe(true);
});

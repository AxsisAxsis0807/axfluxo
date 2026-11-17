import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import { blompClient, blompStorage } from "../../storage/blomp";
import { blompConfiguration } from "../../storage/blomp-config";

const config = blompConfiguration({
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy",
  BLOMP_ACCESS_KEY_ID: "dummy-access",
  BLOMP_SECRET_ACCESS_KEY: "dummy-secret",
})!;

/** Only the native HTTPS transport call is redirected. No injected S3Client,
 * handler replacement, endpoint override, DNS request or external connection.
 * This exercises the factory's real NodeHttpHandler against loopback HTTP;
 * it does not validate TLS or Blomp service compatibility.
 */
async function withTransport(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
  action: (fixture: {
    client: ReturnType<typeof blompClient>;
    handler: NodeHttpHandler;
    requests: https.RequestOptions[];
  }) => Promise<void>,
) {
  const server = http.createServer(respond);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing loopback address");
  const client = blompClient(config);
  const requests: https.RequestOptions[] = [];
  const request = vi.spyOn(https, "request").mockImplementation(((
    options: https.RequestOptions,
    callback: (res: IncomingMessage) => void,
  ) => {
    // Always intercept the HTTPS call; never fall back to the real transport.
    if (options.host !== "storage.blomp.com")
      throw Error("Unexpected request destination");
    requests.push(options);
    return http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        agent: false,
      },
      callback,
    );
  }) as typeof https.request);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(client.config.requestHandler).toBeInstanceOf(NodeHttpHandler);
    await action({
      client,
      handler: client.config.requestHandler as NodeHttpHandler,
      requests,
    });
    expect(
      JSON.stringify([...warn.mock.calls, ...error.mock.calls]),
    ).not.toContain(config.secretAccessKey);
  } finally {
    client.destroy();
    request.mockRestore();
    warn.mockRestore();
    error.mockRestore();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
}

it("factory client sends signed PUT/HEAD/GET with actual bytes through its native Node handler", async () => {
  let bytes = Buffer.alloc(0);
  const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  await withTransport(
    (req, res) => {
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          bytes = Buffer.concat(chunks);
          res.writeHead(200).end();
        });
      } else {
        res.writeHead(200, {
          "content-length": bytes.length,
          "content-type": "application/octet-stream",
        });
        res.end(req.method === "HEAD" ? undefined : bytes);
      }
    },
    async ({ client, handler, requests }) => {
      const input = {
        Bucket: config.bucket,
        Key: "axfluxo/connection-tests/factory/probe.bin",
      };
      const expected = Buffer.from("factory native HTTP handler bytes");
      await client.send(
        new PutObjectCommand({
          ...input,
          Body: expected,
          ContentLength: expected.length,
        }),
      );
      expect(
        (await client.send(new HeadObjectCommand(input))).ContentLength,
      ).toBe(expected.length);
      const result = await client.send(new GetObjectCommand(input));
      expect(hash(await result.Body!.transformToByteArray())).toBe(
        hash(expected),
      );
      expect(hash(bytes)).toBe(hash(expected));
      expect(requests.map((r) => r.method)).toEqual(["PUT", "HEAD", "GET"]);
      for (const request of requests) {
        expect(new URL(request.path!, config.endpoint).pathname).toBe(
          "/dummy/axfluxo/connection-tests/factory/probe.bin",
        );
        const headers = request.headers as Record<string, string>;
        expect(headers.host).toBe("storage.blomp.com");
        expect(headers.authorization).toMatch(
          /^AWS4-HMAC-SHA256 Credential=dummy-access\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=.+, Signature=[a-f0-9]{64}$/,
        );
        expect(JSON.stringify(headers)).not.toContain(config.secretAccessKey);
      }
      expect(await client.config.endpoint?.()).toMatchObject({
        protocol: "https:",
        hostname: "storage.blomp.com",
      });
      expect(await client.config.region()).toBe("us-east-1");
      expect(client.config.forcePathStyle).toBe(true);
      expect(await client.config.maxAttempts()).toBe(1);
      expect(client.config.followRegionRedirects).toBe(false);
      expect(handler.httpHandlerConfigs()).toMatchObject({
        connectionTimeout: 5000,
        requestTimeout: 30000,
        socketTimeout: 30000,
        throwOnRequestTimeout: true,
      });
    },
  );
});

it.each(["requestTimeout", "socketTimeout"] as const)(
  "factory handler enforces %s and adapter redacts the error",
  async (timeout) => {
    await withTransport(
      () => {
        /* deliberately no response */
      },
      async ({ client, handler, requests }) => {
        // Public Smithy configuration API shortens only the test deadline. The actual
        // factory handler and its throwOnRequestTimeout policy remain in use.
        handler.updateHttpClientConfig(timeout, 50);
        const storage = blompStorage(config, client);
        const ref = storage.newTestReference();
        await expect(storage.head(ref)).rejects.toMatchObject({
          name: "BlompError",
          message: "BLOMP_TIMEOUT",
          code: "BLOMP_TIMEOUT",
        });
        expect(requests).toHaveLength(1); // no hidden retry
      },
    );
  },
);

it.each([401, 403])(
  "factory HTTP %s errors never expose response secrets",
  async (status) => {
    await withTransport(
      (_req, res) => {
        res.writeHead(status, { "content-type": "application/xml" });
        res.end(
          `<Error><Code>AccessDenied</Code><Message>${config.secretAccessKey} https://dummy.invalid/?signature=dummy</Message></Error>`,
        );
      },
      async ({ client, requests }) => {
        const storage = blompStorage(config, client);
        const failure = storage.stream(storage.newTestReference());
        await expect(failure).rejects.toMatchObject({
          name: "BlompError",
          message: "BLOMP_AUTH_FAILED",
          code: "BLOMP_AUTH_FAILED",
        });
        await expect(failure).rejects.not.toHaveProperty("cause");
        await failure.catch((error) => {
          expect(String(error) + JSON.stringify(error)).not.toContain(
            config.secretAccessKey,
          );
        });
        expect(requests).toHaveLength(1);
      },
    );
  },
);

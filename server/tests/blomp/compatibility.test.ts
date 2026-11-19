import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  checkCompatibilityGate,
  verifyBlompCompatibility,
} from "../../storage/blomp-compatibility";
import {
  CompatibilityTransport,
  compatibilityMaximumBytes,
  compatibilityMiB,
  type ProbeRequest,
} from "../../storage/blomp-compatibility-transport";

const env = {
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "fake",
  BLOMP_ACCESS_KEY_ID: "dummy-key",
  BLOMP_SECRET_ACCESS_KEY: "dummy-secret",
};
const args = ["--approved-compatibility", "--approved-cleanup"];
const evidence = () => ({
  checkedAt: new Date().toISOString(),
  configuredAccountConfirmed: true,
  freePlan: true,
  noBillOnOverage: true,
  availableBytes: compatibilityMaximumBytes,
});
const origin = "https://axsisaxsis0807.github.io";
function response(
  statusCode: number,
  body: Buffer | string = "",
  headers: Record<string, string> = {},
) {
  const bytes = Buffer.from(body);
  return {
    response: {
      statusCode,
      headers: { "content-length": String(bytes.length), ...headers },
      body: Readable.from(bytes.length ? [bytes] : []),
    },
  };
}
const missing = (code: string) =>
  response(404, `<Error><Code>${code}</Code></Error>`);
const base = (method = "GET", path = "/fake/allowed.bin") => ({
  method,
  path,
  hostname: "storage.blomp.com",
  protocol: "https:",
  query: {},
  headers: {},
  clone(): ProbeRequest {
    return this;
  },
});
function fake({
  lostCreate = false,
  abortFails = false,
  lostComplete = false,
  badRange = false,
} = {}) {
  const uploads = new Map<string, { id: string; parts: Map<number, Buffer> }>();
  const objects = new Map<string, Buffer>();
  const events: Record<string, unknown>[] = [];
  let expired = false;
  const etag = (number: number) => `"opaque-${number}"`;
  const cors = {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "PUT, GET, HEAD",
    "access-control-allow-headers": "content-type, range",
    "access-control-expose-headers": "etag, content-range, content-length",
  };
  const handle = vi.fn(async (request: ProbeRequest) => {
    const key = decodeURIComponent(request.path).slice("/fake/".length);
    expect(key).toMatch(
      /^axfluxo\/connection-tests\/[a-f0-9-]+\/(single|multipart|cancel)\.bin$/,
    );
    const q = request.query;
    const pending = uploads.get(key);
    if (request.method === "OPTIONS") return response(204, "", cors);
    if (request.method === "POST" && Object.hasOwn(q, "uploads")) {
      if (lostCreate && key.endsWith("/multipart.bin"))
        throw Error("dummy-secret signed-url");
      const id = key.endsWith("/multipart.bin") ? "upload-b" : "upload-c";
      uploads.set(key, { id, parts: new Map() });
      return response(
        200,
        `<InitiateMultipartUploadResult><Bucket>fake</Bucket><Key>${key}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === "PUT") {
      expect(q["X-Amz-Algorithm"]).toBe("AWS4-HMAC-SHA256");
      expect(request.headers["content-length"]).toBe(
        String(request.body.byteLength),
      );
      if (q.uploadId) {
        expect(q.uploadId).toBe(pending?.id);
        const number = Number(q.partNumber);
        pending!.parts.set(number, Buffer.from(request.body));
        return response(200, "", { ...cors, etag: etag(number) });
      }
      objects.set(key, Buffer.from(request.body));
      return response(200, "", cors);
    }
    if (q.uploadId) {
      expect(typeof q.uploadId).toBe("string");
      if (!pending || pending.id !== q.uploadId) return missing("NoSuchUpload");
      if (request.method === "DELETE") {
        if (abortFails)
          return response(503, "<Error><Code>SlowDown</Code></Error>");
        uploads.delete(key);
        return response(204);
      }
      if (request.method === "POST") {
        objects.set(key, Buffer.concat([...pending.parts.values()]));
        uploads.delete(key);
        if (lostComplete) throw Error("completion response lost");
        return response(
          200,
          `<CompleteMultipartUploadResult><Key>${key}</Key><ETag>"opaque-complete"</ETag></CompleteMultipartUploadResult>`,
        );
      }
      const parts = [...pending.parts.entries()]
        .map(
          ([number, bytes]) =>
            `<Part><PartNumber>${number}</PartNumber><ETag>${etag(number)}</ETag><Size>${bytes.length}</Size></Part>`,
        )
        .join("");
      return response(
        200,
        `<ListPartsResult><Key>${key}</Key><UploadId>${pending.id}</UploadId><IsTruncated>false</IsTruncated>${parts}</ListPartsResult>`,
      );
    }
    const data = objects.get(key);
    if (request.method === "DELETE") {
      objects.delete(key);
      return response(204);
    }
    if (request.method === "HEAD")
      return response(data ? 200 : 404, "", {
        "content-length": String(data?.length ?? 0),
        ...cors,
      });
    if (!data) return missing("NoSuchKey");
    if (q["X-Amz-Expires"] === "15" && expired)
      return response(403, "<Error><Code>AccessDenied</Code></Error>");
    if (request.headers.range && !badRange)
      return response(206, data.subarray(0, 1024), {
        ...cors,
        "content-range": `bytes 0-1023/${data.length}`,
      });
    return response(200, data, cors);
  });
  return {
    events,
    handle,
    uploads,
    objects,
    run: () =>
      verifyBlompCompatibility({
        env,
        args,
        evidence: evidence(),
        driver: { handle, destroy() {} },
        journal: (event) => events.push(event),
        checkpoint: (value) => JSON.parse(JSON.stringify(value)) as unknown,
        wait: async () => {
          expired = true;
        },
      }),
  };
}
it("holds writes without explicit flags, current verified free capacity and TLS", () => {
  expect(() => checkCompatibilityGate(env, [], evidence())).toThrow(
    "APPROVAL_REQUIRED",
  );
  for (const data of [
    undefined,
    { ...evidence(), availableBytes: 0 },
    { ...evidence(), noBillOnOverage: false },
    {
      ...evidence(),
      checkedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    },
    { ...evidence(), requestAllowance: 59 },
    { ...evidence(), transferRemainingBytes: 1 },
  ]) {
    expect(() => checkCompatibilityGate(env, args, data)).toThrow(
      "CAPACITY_OR_COST_UNCONFIRMED",
    );
  }
  expect(() =>
    checkCompatibilityGate(
      { ...env, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
      args,
      evidence(),
    ),
  ).toThrow("TLS_REQUIRED");
});

it("exercises real SDK serialization and one wire budget with fake responses", async () => {
  const probe = fake();
  const result = await probe.run();
  expect(result.errors).toEqual([]);
  expect(result.outcomes).toEqual({
    ...Object.fromEntries(Object.keys(result.outcomes).map((k) => [k, "PASS"])),
    "browser CORS": "NOT RUN",
  });
  expect(result.requests).toBe(probe.handle.mock.calls.length);
  expect(result.requests).toBe(34);
  expect(result.uploadBytesReserved + result.responseBytes).toBeLessThan(
    compatibilityMaximumBytes,
  );
  expect(result.keysAttempted).toBe(3);
  expect(result.multipartStarts).toBe(2);
  expect(probe.uploads.size).toBe(0);
  expect(probe.objects.size).toBe(0);
  expect(
    probe.handle.mock.calls.filter(([r]) => r.method === "PUT"),
  ).toHaveLength(4);
  expect(JSON.stringify([probe.events, result])).not.toMatch(
    /dummy-secret|dummy-key|X-Amz-Signature/,
  );
});

it("stops new Multipart creation after losing an Upload ID", async () => {
  const probe = fake({ lostCreate: true });
  const result = await probe.run();
  expect(result.outcomes["Multipart start"]).toBe("FAIL");
  expect(result.outcomes.abort).toBe("NOT RUN");
  expect(result.outcomes.absence).toBe("FAIL");
  expect(result.residualPossible).toBe(true);
  expect(result.multipartStarts).toBe(1);
  expect(probe.events.some((e) => e.step === "unknown-upload-id")).toBe(true);
  expect(
    probe.handle.mock.calls.filter(([r]) => r.method === "DELETE"),
  ).toHaveLength(1);
});
it("records an abort failure and attempts no second abort", async () => {
  const probe = fake({ abortFails: true });
  const result = await probe.run();
  expect(result.outcomes.abort).toBe("FAIL");
  expect(result.residualPossible).toBe(true);
  expect(result.multipartStarts).toBe(2);
  expect(
    probe.handle.mock.calls.filter(
      ([r]) => r.method === "DELETE" && r.query.uploadId,
    ),
  ).toHaveLength(1);
});
it("keeps ignored Range distinct from signed GET and preserves cleanup", async () => {
  const result = await fake({ badRange: true }).run();
  expect(result.outcomes["Range GET"]).toBe("FAIL");
  expect(result.outcomes["signed GET"]).toBe("PASS");
  expect(result.outcomes["CORS HTTP"]).toBe("FAIL");
  expect(result.outcomes.absence).toBe("PASS");
});

it("stops before requests 49 and 61 while reserving twelve for cleanup", async () => {
  const handle = vi.fn(async () => response(204));
  const transport = new CompatibilityTransport(
    "fake",
    new Set(["allowed.bin"]),
    { handle, destroy() {} },
  );
  for (let i = 0; i < 48; i++)
    await transport.run(0, false, () => transport.handle(base()));
  await expect(
    transport.run(0, false, () => transport.handle(base())),
  ).rejects.toThrow("PROBE_BUDGET_EXCEEDED");
  for (let i = 0; i < 12; i++)
    await transport.run(0, true, () => transport.handle(base("HEAD")));
  await expect(
    transport.run(0, true, () => transport.handle(base("HEAD"))),
  ).rejects.toThrow("PROBE_BUDGET_EXCEEDED");
  expect(handle).toHaveBeenCalledTimes(60);
});

it("rejects foreign destinations, a third Multipart create, and excess byte reservations", async () => {
  const handle = vi.fn(async () => response(204));
  const transport = new CompatibilityTransport(
    "fake",
    new Set(["allowed.bin", "second.bin", "third.bin"]),
    { handle, destroy() {} },
  );
  const command = { ...base("POST"), query: { uploads: "" } };
  const payload = Buffer.alloc(8 * compatibilityMiB);
  const put = {
    ...base("PUT"),
    headers: { "content-length": String(payload.length) },
    body: payload,
  };
  await expect(
    transport.run(0, true, () =>
      transport.handle(base("DELETE", "/fake/existing")),
    ),
  ).rejects.toThrow("OUT_OF_SCOPE");
  await expect(
    transport.run(0, false, () =>
      transport.handle({ ...base(), hostname: "outside.example" }),
    ),
  ).rejects.toThrow("OUT_OF_SCOPE");
  await transport.run(0, false, () => transport.handle(command));
  await expect(
    transport.run(0, false, () => transport.handle(command)),
  ).rejects.toThrow("PROBE_BUDGET_EXCEEDED");
  await transport.run(0, false, () =>
    transport.handle({ ...command, path: "/fake/second.bin" }),
  );
  await expect(
    transport.run(0, false, () =>
      transport.handle({ ...command, path: "/fake/third.bin" }),
    ),
  ).rejects.toThrow("PROBE_BUDGET_EXCEEDED");
  await expect(
    transport.run(0, true, () =>
      transport.handle({ ...base("DELETE"), query: { uploadId: "foreign" } }),
    ),
  ).rejects.toThrow("OUT_OF_SCOPE_UPLOAD");
  for (let i = 0; i < 7; i++)
    await transport.run(0, false, () => transport.handle(put));
  await expect(
    transport.run(0, false, () => transport.handle(put)),
  ).rejects.toThrow("PROBE_BUDGET_EXCEEDED");
  expect(handle).toHaveBeenCalledTimes(9);
});

it("rejects redirects and oversized bodies before consuming or following them", async () => {
  let value = response(301, "", { location: "https://outside.example/secret" });
  const handle = vi.fn(async () => value);
  const transport = new CompatibilityTransport(
    "fake",
    new Set(["allowed.bin"]),
    { handle, destroy() {} },
  );
  await expect(
    transport.run(4, false, () => transport.handle(base())),
  ).rejects.toThrow("UNSAFE_RESPONSE");
  value = response(200, "12345");
  await expect(
    transport.run(4, false, () => transport.handle(base())),
  ).rejects.toThrow("UNSAFE_RESPONSE");
  expect(handle).toHaveBeenCalledTimes(2);
  value = response(204);
  await expect(
    transport.run(0, false, async () => {
      await transport.handle(base("HEAD"));
      await transport.handle(base("HEAD"));
    }),
  ).rejects.toThrow("OUT_OF_SCOPE");
  expect(handle).toHaveBeenCalledTimes(3);
});

it("reconciles a lost completion by HEAD before deleting, without repeating Complete", async () => {
  const probe = fake({ lostComplete: true });
  const result = await probe.run();
  expect(result.outcomes.complete).toBe("FAIL");
  expect(result.outcomes.delete).toBe("PASS");
  expect(result.outcomes.absence).toBe("PASS");
  expect(result.residualPossible).toBe(false);
  expect(
    probe.handle.mock.calls.filter(
      ([r]) => r.method === "POST" && r.query.uploadId,
    ),
  ).toHaveLength(1);
  expect(probe.objects.size).toBe(0);
});

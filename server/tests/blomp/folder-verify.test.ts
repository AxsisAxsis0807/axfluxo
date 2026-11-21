import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { blompConfiguration } from "../../storage/blomp-config";
import type { ProbeRequest } from "../../storage/blomp-compatibility-transport";
import {
  blompFolderTestBytes,
  verifyBlompFolders,
} from "../../storage/blomp-folder-verify";
import {
  blompTestFolderKeys,
  matchesBlompFileKey,
  newBlompTestKey,
} from "../../storage/blomp-keys";

const id = "12345678-1234-4234-8234-123456789012";
const config = blompConfiguration({
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy",
  BLOMP_ACCESS_KEY_ID: "dummy",
  BLOMP_SECRET_ACCESS_KEY: "dummy",
})!;
const keys = blompTestFolderKeys(id);

it("plans only the three Japanese connection-test prefixes and preserves the old generator", () => {
  expect(keys).toEqual([
    `axfluxo/99_接続テスト/01_元素材/${id}/接続確認.txt`,
    `axfluxo/99_接続テスト/02_途中素材/${id}/接続確認.txt`,
    `axfluxo/99_接続テスト/03_完成品/${id}/接続確認.txt`,
  ]);
  expect(newBlompTestKey("probe.bin", id)).toBe(
    `axfluxo/99_接続テスト/${id}/probe.bin`,
  );
  expect(matchesBlompFileKey(keys[0], "originals", id)).toBe(false);
  expect(() => blompTestFolderKeys("../existing")).toThrow(
    "INVALID_TEST_RUN_ID",
  );
});

it.each([
  [
    "html-success",
    ["PUT", "HEAD", "GET", "PUT", "HEAD", "GET", "PUT", "HEAD", "GET"],
    undefined,
  ],
  ["head-size", ["PUT", "HEAD"], "FOLDER_HEAD_MISMATCH"],
  ["get-corrupt", ["PUT", "HEAD", "GET"], "FOLDER_SHA256_MISMATCH"],
  ["get-html", ["PUT", "HEAD", "GET"], "PROBE_HTML_RESPONSE"],
  ["auth", ["PUT"], "PROBE_AUTH_REQUIRED"],
  ["forbidden", ["PUT"], "PROBE_ACCESS_DENIED"],
  ["rate", ["PUT"], "PROBE_RATE_LIMITED"],
  ["redirect", ["PUT"], "PROBE_REDIRECT_BLOCKED"],
] as const)(
  "enforces scope and HTML reconciliation: %s",
  async (mode, sequence, stop) => {
    const reserve = vi.fn();
    const report = vi.fn();
    const bodies = new Map<string, Buffer>();
    const handle = vi.fn(async (r: ProbeRequest) => {
      expect(reserve).toHaveBeenCalledExactlyOnceWith(keys);
      const path = decodeURIComponent(r.path);
      const key = path.slice("/dummy/".length);
      expect(keys).toContain(key);
      expect(r.path).toContain(encodeURIComponent("99_接続テスト"));
      expect(r.path).toContain(encodeURIComponent("接続確認.txt"));
      expect(r.headers.host).toBe("storage.blomp.com");
      expect(r.headers.authorization).toMatch(
        /^AWS4-HMAC-SHA256 .*\/us-east-1\/s3\/aws4_request/,
      );
      let body = Buffer.alloc(0);
      let length = 0;
      let statusCode = 200;
      if (r.method === "PUT") {
        expect(!bodies.has(key)).toBe(true);
        const source = Buffer.from(r.body);
        expect(source.byteLength).toBe(blompFolderTestBytes);
        bodies.set(key, source);
        statusCode =
          mode === "auth"
            ? 401
            : mode === "forbidden"
              ? 403
              : mode === "rate"
                ? 429
                : mode === "redirect"
                  ? 307
                  : 200;
      } else if (r.method === "HEAD")
        length = bodies.get(key)!.length + Number(mode === "head-size");
      else {
        body = Buffer.from(bodies.get(key)!);
        length = body.length;
        if (mode === "get-corrupt") body[0] ^= 1;
      }
      const html =
        r.method === "PUT" || (r.method === "GET" && mode === "get-html");
      return {
        response: {
          statusCode,
          headers: {
            "content-type": html ? "text/html" : "text/plain",
            "content-length": String(length),
            etag: "opaque",
          },
          body: Readable.from(
            html ? [Buffer.from("private body")] : body.length ? [body] : [],
          ),
        },
      };
    });
    const run = verifyBlompFolders(config, id, reserve, report, {
      handle,
      destroy() {},
    });
    if (stop) {
      await expect(run).rejects.toThrow(stop);
      expect(report.mock.calls.flat()).not.toContain(
        "folder 1 INTEGRITY_VERIFIED",
      );
    } else {
      await run;
      expect([...bodies.keys()]).toEqual(keys);
      for (const index of [1, 2, 3]) {
        expect(
          report.mock.calls
            .flat()
            .filter((line) => line.startsWith(`folder ${index}`))
            .slice(1, 6),
        ).toEqual([
          `folder ${index} SAVE_UNCONFIRMED`,
          `folder ${index} HEAD HTTP 200`,
          `folder ${index} OBJECT_PRESENT`,
          `folder ${index} GET HTTP 200`,
          `folder ${index} INTEGRITY_VERIFIED`,
        ]);
      }
    }
    expect(handle.mock.calls.map(([r]) => r.method)).toEqual(sequence);
    expect(JSON.stringify(report.mock.calls)).not.toContain("private body");
  },
);

it("makes no request when exclusive run reservation fails", async () => {
  const handle = vi.fn();
  await expect(
    verifyBlompFolders(
      config,
      id,
      () => {
        throw new Error("EEXIST");
      },
      vi.fn(),
      { handle, destroy() {} },
    ),
  ).rejects.toThrow("EEXIST");
  expect(handle).not.toHaveBeenCalled();
});

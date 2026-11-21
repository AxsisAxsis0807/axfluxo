import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { blompConfiguration } from "../../storage/blomp-config";
import type { ProbeRequest } from "../../storage/blomp-compatibility-transport";
import {
  diagnosticPngBytes,
  inspectDiagnosticPng,
  verifyBlompImage,
} from "../../storage/blomp-image-verify";

const config = blompConfiguration({
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy",
  BLOMP_ACCESS_KEY_ID: "dummy",
  BLOMP_SECRET_ACCESS_KEY: "dummy",
})!;

// Synthetic PNG header and opaque payload for byte transport tests only.
const fixture = Buffer.alloc(diagnosticPngBytes);
Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(fixture);
fixture.writeUInt32BE(1109, 16);
fixture.writeUInt32BE(628, 20);
const sha256 = inspectDiagnosticPng(fixture);

it.each(["match", "html", "oversize", "corrupt"] as const)(
  "isolates the PNG round trip: %s",
  async (mode) => {
    const record = vi.fn();
    const report = vi.fn();
    const handle = vi.fn(async (request: ProbeRequest) => {
      expect(request.hostname).toBe("storage.blomp.com");
      expect(record).toHaveBeenCalledExactlyOnceWith(
        decodeURIComponent(request.path).slice("/dummy/".length),
      );
      if (request.method === "PUT") {
        expect(Buffer.from(request.body).equals(fixture)).toBe(true);
        expect(request.headers["content-type"]).toBe("image/png");
        return {
          response: {
            statusCode: 200,
            headers: {
              "content-length": "0",
              "content-type": mode === "html" ? "text/html" : "application/xml",
            },
            body: Readable.from([]),
          },
        };
      }
      const payload = Buffer.from(fixture);
      if (mode === "corrupt") payload[payload.length - 1] = 1;
      return {
        response: {
          statusCode: 200,
          headers: {
            "content-length": String(
              payload.length + Number(mode === "oversize"),
            ),
            "content-type": "image/png",
          },
          body: Readable.from([payload]),
        },
      };
    });
    const result = verifyBlompImage(config, fixture, sha256, record, report, {
      handle,
      destroy() {},
    });
    if (mode === "match") {
      expect((await result).equals(fixture)).toBe(true);
      expect(report).toHaveBeenCalledWith("PNG download SHA-256: PASS");
    } else {
      await expect(result).rejects.toThrow();
      expect(report).not.toHaveBeenCalledWith("PNG download SHA-256: PASS");
    }
    expect(handle.mock.calls.map(([request]) => request.method)).toEqual(
      mode === "html" ? ["PUT"] : ["PUT", "GET"],
    );
  },
);

it("rejects an unverified source before recording a key or opening transport", async () => {
  const record = vi.fn();
  const handle = vi.fn();
  await expect(
    verifyBlompImage(config, fixture, "incorrect", record, vi.fn(), {
      handle,
      destroy() {},
    }),
  ).rejects.toThrow("BLOMP_IMAGE_SOURCE_MISMATCH");
  expect(handle).not.toHaveBeenCalled();
  expect(record).not.toHaveBeenCalled();
});

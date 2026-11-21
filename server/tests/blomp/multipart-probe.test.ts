import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { blompConfiguration } from "../../storage/blomp-config";
import type { ProbeRequest } from "../../storage/blomp-compatibility-transport";
import {
  blompMultipartPlans,
  probeBlompMultipart,
} from "../../storage/blomp-multipart-probe";

const config = blompConfiguration({
  BLOMP_ENABLED: "true",
  BLOMP_BUCKET: "dummy",
  BLOMP_ACCESS_KEY_ID: "dummy",
  BLOMP_SECRET_ACCESS_KEY: "dummy",
})!;
const id = "isolated-upload-id";
const mib = 1024 ** 2;

it.each([
  ["B", "match"],
  ["C", "html"],
  ["C", "list-mismatch"],
] as const)(
  "runs the exact %s probe with %s responses",
  async (scenario, mode) => {
    const plan = blompMultipartPlans[scenario];
    const calls: string[] = [];
    const parts: number[] = [];
    const stages: Parameters<
      Parameters<typeof probeBlompMultipart>[0]["checkpoint"]
    >[0][] = [];
    const xml = (tag: string, content: string) => `<${tag}>${content}</${tag}>`;
    const handle = async (request: ProbeRequest) => {
      expect(decodeURIComponent(request.path)).toBe(`/dummy/${plan.key}`);
      const part = Number(request.query.partNumber ?? 0);
      const method = request.method;
      calls.push(method);
      let payload: string | Buffer = "";
      let type = "application/xml";
      let length: number | undefined;
      const element = `<Bucket>dummy</Bucket><Key>${plan.key}</Key><UploadId>${id}</UploadId>`;
      if (method === "POST" && Object.hasOwn(request.query, "uploads")) {
        payload = xml("InitiateMultipartUploadResult", element);
      } else if (method === "PUT") {
        expect(request.query["X-Amz-Algorithm"]).toBe("AWS4-HMAC-SHA256");
        expect(request.query["X-Amz-Credential"]).toMatch(
          /\/us-east-1\/s3\/aws4_request$/,
        );
        expect(request.query.uploadId).toBe(id);
        expect(request.body.byteLength).toBe(part === 1 ? 8 * mib : mib);
        expect(!parts.includes(part)).toBe(true);
        parts.push(part);
        if (mode === "html") {
          type = "text/html";
          payload = "<html>private</html>";
        }
      } else if (method === "GET" && request.query.uploadId) {
        expect(request.query.uploadId).toBe(id);
        payload = xml(
          "ListPartsResult",
          element +
            "<IsTruncated>false</IsTruncated>" +
            parts
              .map(
                (n) =>
                  `<Part><PartNumber>${n}</PartNumber><ETag>tag-${n}</ETag><Size>${mode === "list-mismatch" ? 1 : n === 1 ? 8 * mib : mib}</Size></Part>`,
              )
              .join(""),
        );
      } else if (method === "POST") {
        expect(request.query.uploadId).toBe(id);
        expect(String(request.body)).toContain("tag-1");
        expect(String(request.body)).toContain("tag-2");
        if (mode === "html") {
          type = "text/html";
          payload = "<html>private</html>";
        } else payload = xml("CompleteMultipartUploadResult", element);
      } else if (method === "HEAD") {
        length = 9 * mib;
      } else {
        type = "application/octet-stream";
        payload = Buffer.alloc(9 * mib, plan.byte);
      }
      return {
        response: {
          statusCode: 200,
          headers: {
            "content-type": type,
            "content-length": String(length ?? Buffer.byteLength(payload)),
            etag: part ? `tag-${part}` : "object",
          },
          body: Readable.from(payload.length ? [Buffer.from(payload)] : []),
        },
      };
    };
    const report: string[] = [];
    const run = probeBlompMultipart({
      config,
      scenario,
      checkpoint(event) {
        stages.push(event);
      },
      restoreCheckpoint: () => stages.at(-1)!,
      report: (line) => report.push(line),
      driver: { handle, destroy() {} },
    });
    if (mode === "list-mismatch") {
      await expect(run).rejects.toThrow("MULTIPART_PART_MISMATCH");
      expect(calls).toEqual(["POST", "PUT", "GET"]);
    } else {
      await run;
      expect(parts).toEqual([1, 2]);
      expect(calls).toEqual(
        scenario === "B"
          ? ["POST", "PUT", "GET", "PUT", "GET", "POST", "HEAD", "GET"]
          : ["POST", "PUT", "GET", "GET", "PUT", "GET", "POST", "HEAD", "GET"],
      );
      expect(stages.at(-1)?.stage).toBe("verified");
      expect(report).toContain("MULTIPART_SHA256_MATCH");
      if (mode === "html") expect(report).toContain("COMPLETE_UNCONFIRMED");
    }
    expect(report.join(" ")).not.toContain(id);
    expect(report.join(" ")).not.toContain("private");
  },
);

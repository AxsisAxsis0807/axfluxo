import { test, expect } from "@playwright/test";
import { build } from "esbuild";
let bundle: string;
const owner = "22222222-2222-4222-8222-222222222222",
  batch = "33333333-3333-4333-8333-333333333333",
  job = "44444444-4444-4444-8444-444444444444",
  output = "55555555-5555-4555-8555-555555555555";
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [new URL("drive-cloud-fixture.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN": '"https://cloud-api.test"',
      "process.env.NEXT_PUBLIC_BASE_PATH": '"/axfluxo"',
      "process.env.NODE_ENV": '"test"',
      "process.env": "{}",
    },
    plugins: [
      {
        name: "auth",
        setup(b) {
          b.onLoad({ filter: /\/services\/auth\.ts$/ }, () => ({
            loader: "ts",
            contents: `export const authClient=()=>({auth:{getSession:async()=>({data:{session:{access_token:'mock-supabase',expires_at:9999999999}},error:null})}});`,
          }));
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});
for (const mode of ["all-versions", "fnf"])
  test(`${mode}: resumable upload, worker-ready wording, immutable submission and explicit Files confirmation`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rows = new Map<string, Record<string, unknown>>();
    let count = 0,
      submitted: Record<string, unknown> | undefined,
      confirmed: Record<string, unknown> | undefined;
    const batchView = (finished = false) => ({
      id: batch,
      ownerId: owner,
      jobs: [
        {
          id: job,
          state: finished ? "succeeded" : "queued",
          rangeIndex: 0,
          attempt: 1,
          retryOf: null,
        },
      ],
      outputs: finished
        ? [
            {
              id: output,
              jobId: job,
              reference: {
                libraryId: "render-output",
                fileId: output,
                versionId: output,
                hash: "a".repeat(64),
                kind: "video",
              },
            },
          ]
        : [],
    });
    await page.route("https://cloud-api.test/**", async (route) => {
      const r = route.request(),
        path = new URL(r.url()).pathname,
        headers = {
          "access-control-allow-origin": "https://cloud-ui.test",
          "access-control-allow-methods": "POST,GET,OPTIONS",
          "access-control-allow-headers":
            "authorization,content-type,idempotency-key",
        };
      if (r.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers });
        return;
      }
      expect(r.headers().authorization).toBe("Bearer mock-supabase");
      let body: unknown = {};
      if (path === "/v1/developer/me")
        body = { ownerId: owner, membership: "developer" };
      else if (path === "/v1/drive/status")
        body = {
          enabled: true,
          connected: true,
          chunkBytes: 4194304,
          maxFileBytes: 2147483648,
          monthlyEstimateYen: 0,
          priceConfirmed: true,
          allow1440: false,
        };
      else if (path === "/v1/drive/uploads") {
        const p = r.postDataJSON(),
          id = `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`;
        body = {
          id,
          state: "uploading",
          offset: 0,
          size: p.size,
          sha256: p.sha256,
          error: null,
          reference: null,
          probe: null,
        };
        rows.set(id, body as Record<string, unknown>);
      } else if (path.startsWith("/v1/drive/uploads/")) {
        const id = path.split("/")[4],
          row = rows.get(id)!;
        if (path.includes("/chunks/")) {
          row.state = "verifying";
          row.offset = row.size;
          body = row;
        } else {
          if (row.state === "verifying") {
            row.state = "ready";
            row.reference = {
              libraryId: "cloud",
              fileId: id,
              versionId: id,
              hash: row.sha256,
              kind: id.endsWith("1") ? "video" : "image",
            };
            row.probe = id.endsWith("1")
              ? {
                  durationUs: 1000000,
                  width: 160,
                  height: 90,
                  displayWidth: 160,
                  displayHeight: 90,
                  kind: "video",
                }
              : { width: 16, height: 16, kind: "image" };
          }
          body = row;
        }
      } else if (path === "/v1/drive/batches") {
        submitted = r.postDataJSON();
        body = { ...batchView(), workerReady: true };
      } else if (path === "/v1/drive/batches/" + batch) body = batchView(true);
      else if (path.endsWith("/ticket"))
        body = {
          url: "/v1/drive/download/" + "x".repeat(43),
          versionId: output,
          sha256: "a".repeat(64),
          size: 1234,
          expiresIn: 600,
        };
      else if (path.endsWith("/saved")) {
        confirmed = r.postDataJSON();
        body = { saved: true, deleted: false };
      }
      await route.fulfill({ json: body, headers });
    });
    await page.route("https://cloud-ui.test/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div id="root"></div><script>' + bundle + "</script>",
      }),
    );
    await page.goto("https://cloud-ui.test/axfluxo/developer/video/?" + mode);
    await expect(
      page.getByRole("link", { name: "Google Drive接続設定" }),
    ).toHaveAttribute("href", "/axfluxo/developer/video/");
    await page
      .getByRole("button", { name: "Cloud利用条件・接続を確認" })
      .click();
    await page.getByRole("button", { name: "素材をDriveへ送信・再開" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Workerによる全体ハッシュ",
    );
    expect(submitted).toBeUndefined();
    await page.reload();
    await page
      .getByRole("button", { name: "Cloud利用条件・接続を確認" })
      .click();
    await page.getByRole("button", { name: "素材をDriveへ送信・再開" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Workerによる全体ハッシュ",
    );
    expect(count).toBe(mode === "fnf" ? 1 : 2);
    await page.getByRole("button", { name: "検証確認・ジョブ送信" }).click();
    await expect(page.getByRole("status")).toContainText("サーバー受領済み");
    expect(JSON.stringify(submitted)).not.toContain("blob:");
    expect(JSON.stringify(submitted)).not.toContain("video-fixture");
    await page.getByRole("button", { name: "ジョブ状態を確認" }).click();
    await page
      .getByRole("button", { name: "保存用リンクを発行・再発行" })
      .click();
    const confirm = page.getByRole("button", { name: "本人の保存確認を記録" });
    await expect(confirm).toBeDisabled();
    await page.getByRole("checkbox").check();
    await confirm.click();
    await expect(page.getByRole("status")).toContainText("削除されません");
    expect(confirmed).toMatchObject({ destination: "files", opened: true });
    expect(
      await page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain("mock-supabase");
  });

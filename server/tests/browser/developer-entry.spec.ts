import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
test.setTimeout(60_000);
let bundle: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [
      new URL("developer-entry-fixture.tsx", import.meta.url).pathname,
    ],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: {
      "process.env": "{}",
      "process.env.NODE_ENV": '"test"',
      "process.env.NEXT_PUBLIC_BASE_PATH": '""',
    },
    plugins: [
      {
        name: "session",
        setup(b) {
          b.onLoad({ filter: /\/services\/auth\.ts$/ }, () => ({
            loader: "ts",
            contents: `
      const auth = { getSession: async () => ({ data: {session: {access_token: "test", expires_at: 9999999999, user_metadata: {role:"developer"}, user: {id: "11111111-1111-4111-8111-111111111111"}}},error: null}), onAuthStateChange: () => ({data: {subscription: {unsubscribe(){}}}}) };
      export const authClient = () => ({auth, rpc: async () => { const r=await fetch("https://entry-api.test/access",{method:"POST"}); return {data:await r.json(),error: r.ok ? null : {code:"RPC_FAILED"}}; }}); export const authError = () => "error"; export const authRedirect = () => "/";`,
          }));
        },
      },
    ],
  });
  bundle = result.outputFiles[0].text;
});
for (const mode of ["all-versions", "fnf-showcase"] as const)
  test(`local ${mode} accepts device files and exports without video API`, async ({
    page,
  }) => {
    const dir = await mkdtemp(join(tmpdir(), "local-tool-")),
      file = join(dir, "source.mp4"),
      cover = join(dir, "cover.png");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:size=160x90:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-c:a",
      "aac",
      "-y",
      file,
    ]);
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=red:size=16x16",
      "-frames:v",
      "1",
      "-threads",
      "1",
      "-y",
      cover,
    ]);
    const unexpected: string[] = [],
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (
        !r.url().startsWith("https://entry.test/") &&
        !r.url().startsWith("blob:") &&
        !r.url().startsWith("https://entry-api.test/access")
      )
        unexpected.push(r.url());
    });
    await page.route("https://entry-api.test/access", (r) =>
      r.fulfill({
        headers: { "access-control-allow-origin": "*" },
        contentType: "application/json",
        body: JSON.stringify({
          ownerId: "11111111-1111-4111-8111-111111111111",
          membership: "developer",
          validUntil: new Date(Date.now() + 60000).toISOString(),
        }),
      }),
    );
    await page.route("https://entry.test/**", (r) =>
      r.fulfill(
        new URL(r.request().url()).pathname === "/bundle.js"
          ? { contentType: "application/javascript", body: bundle }
          : {
              contentType: "text/html",
              body: '<html><div id="root"></div><script src="/bundle.js"></script></html>',
            },
      ),
    );
    await page.goto(`https://entry.test/developer/${mode}/`);
    await page
      .getByLabel("パスコード", { exact: true })
      .fill("test-only-passcode");
    await page
      .getByLabel("パスコードの確認", { exact: true })
      .fill("test-only-passcode");
    await page.getByRole("button", { name: "設定してロック解除" }).click();
    await expect(
      page.getByRole("heading", { name: "Developer Studio", exact: true }),
    ).toBeVisible();
    await page.goto(`https://entry.test/developer/${mode}/`);
    const files = [
      {
        name: "source.mp4",
        mimeType: "video/mp4",
        buffer: await readFile(file),
      },
    ];
    if (mode === "all-versions" && test.info().project.name === "chromium") {
      for (const [extension, mimeType, options] of [
        ["mp3", "audio/mpeg", ["-vn", "-c:a", "libmp3lame"]],
        ["wav", "audio/wav", ["-vn", "-c:a", "pcm_s16le"]],
        ["m4a", "audio/mp4", ["-vn", "-c:a", "aac"]],
        ["mov", "video/quicktime", ["-c", "copy"]],
      ] as const) {
        const path = join(dir, `source.${extension}`);
        execFileSync("ffmpeg", [
          "-v",
          "error",
          "-i",
          file,
          ...options,
          "-y",
          path,
        ]);
        files.push({
          name: `source.${extension}`,
          mimeType,
          buffer: await readFile(path),
        });
      }
    }
    await page.getByLabel("端末の素材", { exact: true }).setInputFiles(files);
    await expect(
      page.getByRole("button", { name: "端末内で書き出す" }),
    ).toBeEnabled();
    if (mode === "all-versions") {
      await page.getByLabel("カバー画像").setInputFiles({
        name: "cover.png",
        mimeType: "image/png",
        buffer: await readFile(cover),
      });
      await page
        .getByLabel("version名（1行に1つ）")
        .fill(files.map((_, i) => `local version ${i + 1}`).join("\n"));
    } else {
      await page.getByLabel("譜面名", { exact: true }).fill("local chart");
      await page
        .getByRole("button", { name: "rangeを追加", exact: true })
        .click();
      await page
        .getByLabel("譜面名", { exact: true })
        .nth(1)
        .fill("second chart");
    }
    await page
      .getByRole("button", { name: "テンプレートを端末に保存" })
      .click();
    await page
      .getByRole("button", { name: "端末のテンプレートを読み込む" })
      .click();
    await page.getByRole("button", { name: "波形を生成" }).first().click();
    await expect(
      page.getByText(
        test.info().project.name === "chromium"
          ? /^波形生成済み$/
          : /波形生成済み|この素材の波形を端末で解析できません/,
      ),
    ).toBeVisible();
    await page.getByRole("button", { name: "合成プレビューを更新" }).click();
    await expect(
      page.getByRole("region", { name: "合成プレビュー" }).locator("canvas"),
    ).toBeVisible();
    const available = await page.evaluate(
      () =>
        typeof MediaRecorder !== "undefined" &&
        [
          "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
          "video/mp4",
          "video/webm;codecs=vp8,opus",
        ].some((t) => MediaRecorder.isTypeSupported(t)),
    );
    await page.getByRole("button", { name: "端末内で書き出す" }).click();
    if (available) {
      await expect(
        page
          .getByRole("region", { name: "端末内書き出し", exact: true })
          .getByRole("status"),
      ).toContainText("完了", {
        timeout: 20000,
      });
      const save = page.getByRole("link", { name: /を保存/ });
      await expect(save).toHaveCount(mode === "fnf-showcase" ? 2 : 1);
      const downloadPromise = page.waitForEvent("download");
      await save.first().click();
      const downloaded = await downloadPromise;
      const saved = join(dir, downloaded.suggestedFilename());
      await downloaded.saveAs(saved);
      const probe = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_streams", "-of", "json", saved],
          { encoding: "utf8" },
        ),
      );
      expect(
        probe.streams.some(
          (s: { codec_type: string }) => s.codec_type === "audio",
        ),
      ).toBe(true);
      expect(
        probe.streams.some(
          (s: { codec_type: string }) => s.codec_type === "video",
        ),
      ).toBe(true);
    } else
      await expect(
        page
          .getByRole("region", { name: "端末内書き出し", exact: true })
          .getByRole("status"),
      ).toContainText("対応していません");
    expect(unexpected).toEqual([]);
    expect(errors).toEqual([]);
  });

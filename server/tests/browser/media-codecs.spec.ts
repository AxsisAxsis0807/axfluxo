import { test, expect } from "@playwright/test";
/** These UI suites exercise the production H.264/AAC MP4 contract, not a WebM substitute. */
test("browser supports the required H.264 and AAC MP4 codecs", async ({
  page,
  browserName,
  browser,
}) => {
  const support = await page.evaluate(() => ({
    video: document
      .createElement("video")
      .canPlayType('video/mp4; codecs="avc1.42E01E"'),
    audio: document
      .createElement("audio")
      .canPlayType('audio/mp4; codecs="mp4a.40.2"'),
  }));
  expect(
    support.video,
    `${browserName} ${browser.version()}: H.264 decoder required`,
  ).not.toBe("");
  expect(
    support.audio,
    `${browserName} ${browser.version()}: AAC decoder required`,
  ).not.toBe("");
});

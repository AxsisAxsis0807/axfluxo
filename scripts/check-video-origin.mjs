/**
 * Build-time guard: NEXT_PUBLIC_VIDEO_API_ORIGIN is inlined into the static bundle,
 * so a build without it silently disables the server export panel.
 */
const origin = process.env.NEXT_PUBLIC_VIDEO_API_ORIGIN;
if (!origin) {
  console.error(
    "NEXT_PUBLIC_VIDEO_API_ORIGIN is required for a build with server export.",
  );
  process.exit(1);
}
try {
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new Error("shape");
  console.log(`Video API origin: ${url.origin}`);
} catch {
  console.error(
    "NEXT_PUBLIC_VIDEO_API_ORIGIN must be an https origin without a path.",
  );
  process.exit(1);
}

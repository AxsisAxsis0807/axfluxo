import { pathToFileURL } from "node:url";
import { checkDeveloperConfig } from "./check-developer-config.mjs";
/** Anonymous, read-only deployment preflight. Never uses a user token or claims membership/worker health. */
export async function checkDeveloperApi(env, transport = fetch) {
  if (env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED !== "true") return;
  checkDeveloperConfig(env);
  const origin = env.DEVELOPER_APP_ORIGIN || "https://axsisaxsis0807.github.io";
  if (new URL(origin).origin !== origin || !origin.startsWith("https://"))
    throw Error("Invalid application origin");
  const url = new URL("/v1/developer/me", env.NEXT_PUBLIC_VIDEO_API_ORIGIN);
  const common = {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  };
  const preflight = await transport(url, {
    ...common,
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  if (
    preflight.status !== 204 ||
    preflight.headers.get("access-control-allow-origin") !== origin ||
    !/\bauthorization\b/i.test(
      preflight.headers.get("access-control-allow-headers") ?? "",
    )
  )
    throw Error("Authorization API CORS is not ready");
  for (const authorization of [null, "Bearer invalid.invalid.invalid"]) {
    const response = await transport(url, {
      ...common,
      signal: AbortSignal.timeout(10000),
      headers: {
        Origin: origin,
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });
    if (
      response.status !== 401 ||
      response.headers.get("access-control-allow-origin") !== origin ||
      !/\bno-store\b/i.test(response.headers.get("cache-control") ?? "")
    )
      throw Error(
        "Authorization API did not deny an unauthenticated request safely",
      );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await checkDeveloperApi(process.env);
  } catch {
    process.stderr.write(
      "Developer authorization API preflight failed. Keep the entry OFF; verify the real HTTPS API, authentication and explicit CORS origin.\n",
    );
    process.exitCode = 1;
  }
}

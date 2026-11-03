import { pathToFileURL } from "node:url";
/** Public configuration is validated even when OFF: a display flag cannot hide an embedded secret. */
export function checkDeveloperConfig(env) {
  const flags = [
    "NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED",
    "NEXT_PUBLIC_ALL_VERSIONS_ENABLED",
    "NEXT_PUBLIC_FNF_SHOWCASE_ENABLED",
    "NEXT_PUBLIC_VIDEO_PREVIEW_ENABLED",
  ];
  for (const name of flags)
    if (env[name] !== undefined && !["true", "false", ""].includes(env[name]))
      throw Error(`Invalid boolean flag: ${name}`);
  const enabled = env.NEXT_PUBLIC_DEVELOPER_STUDIO_ENABLED === "true";
  if (!enabled && flags.slice(1).some((name) => env[name] === "true"))
    throw Error("Developer tools require the parent Studio flag");
  if (enabled && !env.NEXT_PUBLIC_VIDEO_API_ORIGIN)
    throw Error(
      "Developer Studio requires a real HTTPS authorization API origin",
    );
  if (env.NEXT_PUBLIC_VIDEO_API_ORIGIN) {
    let url;
    try {
      url = new URL(env.NEXT_PUBLIC_VIDEO_API_ORIGIN);
    } catch {
      throw Error("Invalid public API origin");
    }
    if (
      url.protocol !== "https:" ||
      url.origin + "/" !== url.href ||
      url.username ||
      url.password
    )
      throw Error(
        "Developer Studio requires an HTTPS API origin without path, query or credentials",
      );
  }
  if (
    enabled ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  ) {
    if (
      !env.NEXT_PUBLIC_SUPABASE_URL ||
      !env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith(
        "sb_publishable_",
      ) ||
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.length < 30
    )
      throw Error(
        "Existing Supabase public authentication configuration is required",
      );
    const auth = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
    if (
      auth.protocol !== "https:" ||
      !auth.hostname.endsWith(".supabase.co") ||
      auth.username ||
      auth.password ||
      auth.pathname !== "/" ||
      auth.search ||
      auth.hash
    )
      throw Error("Invalid public authentication origin");
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    checkDeveloperConfig(process.env);
  } catch {
    process.stderr.write(
      "Public Developer Studio configuration is incomplete or invalid. Do not publish credentials; keep flags OFF until the real authorization API is configured.\n",
    );
    process.exitCode = 1;
  }
}

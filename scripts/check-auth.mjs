// Read-only probe. Never creates users or sends email.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key?.startsWith("sb_publishable_"))
  throw new Error("Public Supabase configuration is missing");
const response = await fetch(`${url}/auth/v1/settings`, {
  headers: { apikey: key },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok)
  throw new Error(`Supabase settings request failed: HTTP ${response.status}`);
const settings = await response.json();
if (!settings.external?.email || settings.mailer_autoconfirm !== false)
  throw new Error("Email provider or Confirm Email is not enabled");
console.log(
  "Supabase accepted the publishable key; Email provider and Confirm Email are enabled.",
);

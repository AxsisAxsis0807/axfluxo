# PR #48 iPhone preview

The **PR 48 iPhone preview** workflow builds the exact PR head and stores
`axfluxo-pr48-iphone-preview` as an artifact for seven days. It uses a read-only
checkout and has no deployment job or hosting credentials. The production
Pages workflow continues to deploy only from main.

## HTTPS hosting

Download and extract the artifact from the PR's Actions run. In a free
Cloudflare account, create a **new** Pages project using Direct Upload and
upload the extracted files at the root. Use that project's HTTPS URL shown
by Cloudflare. The root links to the All Versions editor. Deleting the
preview project stops hosting and does not touch the production Pages site.

An existing Pages project can only serve its current production artifact.
Deploying to a dedicated Pages repository requires separate repository and
Pages settings. A Quick Tunnel is suitable for a temporary test when the
host can connect to Cloudflare and stay running. In the Codex environment
the tunnel endpoint was blocked, so upload of the isolated artifact is the
available hosting path.

The preview URL is public to anyone who has it. The built-in passcode is a
local lock, not hosting access control. Do not reuse a real password.
The build omits production API and Supabase configuration and uses only the
device-local All Versions editor. Media and output stay in Safari.
The artifact contains same-origin CSP and noindex headers for Pages.
Do not place private files or API credentials in the hosting project.

## Device test

1. Open the preview in Safari and set a temporary local passcode.
2. Select a short MP3 or WAV and a cover. Add a version marker and enter two
   names. Update the composition preview and seek across the marker.
3. Start local export and keep Safari in the foreground. Open export details,
   save the MP4, and open it in Files. Check the duration, sound, title fade
   and timer reset. Repeat with the longer reference test, then reopen the
   project to verify restoration.
4. If an export fails, copy **書き出し診断**. It shows browser family, API
   availability, selected encoder and a sanitized failure category. Do not
   share the selected files or passcode in a public issue.

## Linux WebKit boundary

The iPhone preview acceptance fixtures use MP3 and WAV. Linux WebKit can
report MP3 encoder padding, or the full container duration of AAC-in-video,
even if the audio decoder does not deliver every sample in that interval. All Versions stops before save
in that case and explains that the selected interval could not be decoded.
The WebKit editor smoke test explicitly sets a decodable end time for
both MP3 and WAV. If an iPhone reports a similar error at the default end,
check the source and set the end to the actual audio interval before retrying.

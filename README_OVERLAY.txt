WBO Japanese administrator dashboard and native color picker overlay

Target: kotaaaaaaaa12/whitebophir, base commit 06e675c5cd8a25900f0b7aa771933e29f551f96a.
Extract into the repository root and overwrite the included files.
Keep repository files not included here. This is a cumulative overlay containing
all earlier Cloudflare persistence, names, deletion, touch/palette and admin fixes.

Deploy command: npx wrangler deploy
Workers Builds build command: leave blank.
Keep the existing private R2 bucket, Durable Object bindings, migration and named
instance IDs. No storage reset or new migration is required. APAC/standard-2 and
10-minute idle sleep are retained.

After the Container update completes, open:
https://whitebophir.what-the-fuck.men/admin
Use the existing WBO_BOARD_ADMIN_KEY Worker Secret to sign in.
The dashboard supports Auto / English / Japanese with live language switching,
local preference persistence and explicit ?lang=ja or ?lang=en URL overrides.
Auto uses Japanese for a preferred Japanese browser locale, English otherwise.
Japanese board controls, display-name messages and deletion/admin dialogs are
also translated. Opening a board carries the selected dashboard language.

The rainbow swatch now contains a directly tappable HTML input[type=color].
The browser/OS supplies the native picker; no custom HEX/RGB modal is loaded.
The full swatch is tappable and keyboard-focusable. Standard color input/change
events update drawing color, preview and persisted browser preference.
Physical iOS native picker chrome has not been tested in this environment.

Node 398 tests pass; application/Worker typechecks and lint pass. Focused native
color, administrator and dashboard tests pass on Chromium and WebKit. Related
touch/palette/deletion tests also pass (9 passed, 1 WebKit CDP-only skip).
The Cloudflare persistence adapter and stored resource identities are unchanged
by this UI update. See CLOUDFLARE.md for details and validation limits.

This artifact has not been deployed to production by its author.

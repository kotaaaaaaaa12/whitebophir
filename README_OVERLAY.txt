WBO all-language cumulative overlay

Target: kotaaaaaaaa12/whitebophir, base commit 06e675c5cd8a25900f0b7aa771933e29f551f96a.
Extract into the repository root and overwrite the included files.
Keep all repository files not included here. This cumulative overlay contains
all earlier Cloudflare persistence, names, deletion, touch/palette and admin fixes.

Deploy command: npx wrangler deploy
Workers Builds build command: leave blank.
Keep the existing private R2 bucket, Durable Object bindings, migration and named
instance IDs. No storage reset or new migration is required. APAC/standard-2 and
10-minute idle sleep are retained.

After the Container update completes, open:
https://whitebophir.what-the-fuck.men/admin
Use the existing WBO_BOARD_ADMIN_KEY Worker Secret to sign in.

All added board controls, display-name messages, administration, deletion dialogs,
and dashboard labels/errors/counts are translated into all 21 WBO languages:
ar, be, ca, de, en, es, fr, hu, id, it, ja, my, pt, ru, sw, th, uk, vi,
zh-CN, zh-TW, pl.
The dashboard offers Auto plus all 21 languages, live switching and persistent
browser preferences. A supported ?lang= value takes precedence over storage.
Auto chooses the first supported browser preference and falls back to English.
Regional tags map to their language; Chinese scripts/regions choose simplified
or traditional Chinese. Arabic uses RTL dashboard layout. Opening a board
carries the selected language. Worker startup/unavailability text is localized
using the URL language or weighted Accept-Language request preferences.

The rainbow swatch contains a directly tappable HTML input[type=color].
The browser/OS supplies the native picker, including its language and appearance;
no custom HEX/RGB modal is loaded. The full swatch is tappable and keyboard-
focusable. Standard color events update drawing color, preview and saved preference.
Physical iOS native picker chrome has not been tested in this environment.

Validation: 401 Node tests, 24 focused Chromium/WebKit browser tests, all four
Cloudflare persistence integration tests, application/Worker typechecks, lint,
and a Worker-only dry build. Translation checks cover every added key and
placeholder in all 21 dictionaries. Browser checks cover all-language switching,
errors/counts/confirmation, regional auto-detection, RTL and narrow layouts,
localized board links, administrator auth/deletion, and native color input.
French, Arabic and traditional-Chinese mobile layouts were visually inspected.
Translations have not received independent native-speaker review.
The full Docker image and production deployment were not run in this environment.
See CLOUDFLARE.md for complete instructions and validation limits.

This artifact has not been deployed to production by its author.

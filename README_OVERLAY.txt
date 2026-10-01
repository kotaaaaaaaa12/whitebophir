WBO persistent per-board chat cumulative overlay

Target: kotaaaaaaaa12/whitebophir, base commit 06e675c5cd8a25900f0b7aa771933e29f551f96a.
Extract into the repository root and overwrite the included files.
Keep all repository files not included here. This cumulative overlay contains
all earlier Cloudflare persistence, names, deletion, touch/palette, administrator
dashboard and all-language fixes.

Deploy command: npx wrangler deploy
Workers Builds build command: leave blank.
Wait for the Container update to complete before testing the new UI.
Keep the existing private R2 bucket, Durable Object bindings, v1 migration and
named instance IDs. No storage reset, new migration tag or database setup is
required. APAC/standard-2 and 10-minute idle sleep are retained.

A speech-bubble button directly under the upper-right people icon opens chat.
Each board has its own realtime messages with sender display name and timestamp.
Enter sends; Shift+Enter adds a newline. Up to 1,000 Unicode characters per message.
IME composition does not send early. Failed sends keep the draft for retry.
The latest 50 messages load first; Older messages retrieves previous pages.
History has no automatic expiry. Cloudflare saves chat in the existing storage
Durable Object SQLite before delivery, so it survives Container sleep, updates
and an empty Container disk. Ordinary Node hosting requires >=22.13 and stores
per-board chat SQLite files in the history directory; the Container uses Node 24.
Deleting a board also deletes its chat; drawing Clear preserves chat history.
Chat follows board/JWT access; unbanned readonly drawing viewers can also chat.
Names and timestamps come from the server, and messages render as plain text.
Chat does not introduce polling or a separate keepalive.

All added controls and errors, including chat, support all 21 WBO languages:
ar, be, ca, de, en, es, fr, hu, id, it, ja, my, pt, ru, sw, th, uk, vi,
zh-CN, zh-TW, pl. Existing Auto/manual language preferences remain supported.
Translations have not received independent native-speaker review.

The existing administrator dashboard is at /admin. Sign in with the existing
WBO_BOARD_ADMIN_KEY Worker Secret. The native color input and anchored touch
pinching fixes are included. Physical iOS native picker chrome is not validated.

Validation: 405 passing Node tests, five Cloudflare persistence integration tests,
30 focused browser cases across Chromium and iPad-configured WebKit, application
and Worker typechecks, lint and a Worker-only dry build. Chat checks include
103-message pagination, isolation, retry deduplication, malformed input, limits,
ban/deletion fences, delayed-upload races, storage restarts and Socket.IO delivery
before an abrupt Node exit followed by an empty-disk restart. Browser checks cover
peer delivery/reload history, literal markup, real-key focus, IME, multiline,
failed-send retry, mobile/landscape fitting and RTL. The optional Playwright-wide
typecheck still reports pre-existing upstream module-declaration/helper errors.
The full Docker image and production deployment were not run in this environment.
See CLOUDFLARE.md for full behavior, instructions and validation limits.

This artifact has not been deployed to production by its author.

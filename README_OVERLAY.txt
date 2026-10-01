WBO Cloudflare administrator dashboard overlay

Target: kotaaaaaaaa12/whitebophir, base commit 06e675c5cd8a25900f0b7aa771933e29f551f96a
Extract into the repository root and overwrite the included files.
Keep all repository files that are not included. This is a cumulative overlay:
it includes the earlier Cloudflare persistence, names, deletion, touch/palette,
custom color and administrator password fixes.

Deploy: npx wrangler deploy
Workers Builds build command: leave blank. Deploy command: npx wrangler deploy.
Keep the existing R2 bucket, Durable Object bindings, migration and named IDs.
No storage reset or additional migration is needed. APAC/standard-2 retained.

After the Container update completes, open:
https://whitebophir.what-the-fuck.men/admin
Use the existing WBO_BOARD_ADMIN_KEY Worker Secret to sign in.
The people panel also has an All boards link. Search, Open, Delete, Refresh and
Load more are available. Only signed administrators can retrieve the list.
Public/default boards cannot be deleted; open them to clear their drawings.
Deleting a board is permanent and reserves its old URL (HTTP 410).
The dashboard does not poll, allowing an idle Container to sleep.

See CLOUDFLARE.md for configuration and validation details.
This artifact has not been deployed to production by its author.

Vigileon League - latest project files (built 2026-11-04)

website/  Everything deployed to Cloudflare Pages (index.html, _worker.js, sw.js,
          manifest, icons, images, .well-known/assetlinks.json).
          Upload this folder's CONTENTS to the Pages project.
cron/     The timed Cloudflare Worker "vigileon-cron" (vigileon-cron.js, wrangler.toml).
          Deploy with: npx wrangler deploy   (see cron/CRON-SETUP.md)
docs/     Setup and Play Store guides, plus play-store/ (TWA manifest).

Secrets are NOT in these files. Set them in Cloudflare:
  FIREBASE_SERVICE_ACCOUNT_JSON, RESEND_API_KEY, PAYSTACK_SECRET_KEY, CRON_TEST_KEY, ...

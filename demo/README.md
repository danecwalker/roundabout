# Acme demo

A pretend customer site on its own origin, protected by Roundabout. Start the API first, then run:

```sh
node demo/server.mjs   # → http://localhost:8795
```

On first run it signs up `demo@roundabout.local`, creates a site for `localhost`, and saves the
sitekey and secret to `demo/.demo-site.json` (git-ignored). To use your own site, set `SITEKEY` and `SECRET`.
Set `ROUNDABOUT_URL` and `DEMO_PORT` to change where the API is and which port the demo uses.

| Page | Shows |
| --- | --- |
| `/` | A sign-up form protected by the widget. The server checks the token with `/v1/siteverify`, shows the full response, and offers a "Report as abuse" button that calls `/v1/feedback`. |
| `/playground` | Every widget option side by side: modes, test keys, themes, sizes, languages, interaction-only, and execute-on-demand. A live log shows each callback as it fires. |
| `/members` | A whole section gated by pre-clearance using `gate()` from `@roundabout/clearance`. You solve one challenge, then browse the section freely until the cookie expires. |

# Clipnote — free-tier setup

Clipnote is a responsive caption studio for clips up to 100 MB. This version uses Cloudflare Pages for the website, a Cloudflare Worker for the API, Cloudflare R2 for temporary video storage, and Google Gemini 2.5 Flash-Lite for video understanding.

## What “free” means here

The design targets providers’ free tiers, but **no provider promises these tiers will remain free forever**. Free quotas are limited and can change. If the app goes over them, service can stop or fees may apply depending on the provider account and current terms. Check account billing settings before enabling anything paid. The app has no user accounts or usage quotas, so do not share it publicly without adding abuse controls.

At the time of writing, Cloudflare Pages and Workers have free plans, R2 includes monthly free storage/operation allowances, and Gemini 2.5 Flash-Lite lists free input/output on its free tier. See the current [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [R2 pricing](https://developers.cloudflare.com/r2/pricing/), and [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing) before launch. Gemini free-tier requests may be used to improve Google products. Don’t upload private or sensitive clips unless that use is acceptable to you.

## One-time setup

You need a free Cloudflare account and a Gemini API key from Google AI Studio. The Gemini key stays in the Worker secret store; it is never included in the website.

### 1. Create the temporary clip bucket

In Cloudflare Dashboard, open **R2 Object Storage** and create a bucket named `clipnote-clips` using the Standard class. Configure a lifecycle rule to remove objects after one day as a cleanup backstop. Clips are deleted after generation; the lifecycle rule removes abandoned uploads.

### 2. Deploy the Worker API

Install Node.js, then from the `worker` folder run:

```sh
npm install
npx wrangler login
npx wrangler secret put GEMINI_API_KEY
npm run deploy
```

Paste the Google AI Studio key when prompted. In the Cloudflare Worker settings, bind the R2 bucket as **`CLIPS`** → `clipnote-clips`. Set Worker variable `ALLOWED_ORIGINS` to the website origin after the Pages site is created (for example `https://clipnote.pages.dev`). Optionally set `GEMINI_MODEL` to another currently free-tier model available to your account. The default is `gemini-2.5-flash-lite`.

The Worker API has a `/upload` endpoint that streams the clip into R2 and a `/generate` endpoint that sends it to Gemini, returns five captions, and deletes both temporary files. The upload is capped at 100,000,000 bytes.

### 3. Publish the site through GitHub and Cloudflare Pages

The source repository is [vegasdowntownshows/clipnote-caption-studio](https://github.com/vegasdowntownshows/clipnote-caption-studio). In Cloudflare Dashboard, create a **Pages** project and connect this GitHub repository:

- Framework preset: **Vite**
- Build command: `npm run build`
- Build output directory: `dist`
- Build environment variable: `VITE_API_URL` = your Worker URL, e.g. `https://clipnote-api.YOUR-SUBDOMAIN.workers.dev`

Deploy the Pages site. Set the Worker `ALLOWED_ORIGINS` variable to the exact Pages URL, then redeploy the Worker. Visit `/health` on the Worker URL and confirm it returns `{"ok":true}`. The public Pages site is the link you can share.

For local frontend work, copy `.env.example` to `.env`, set `VITE_API_URL`, run `npm install`, then `npm run dev`.

## Privacy and practical limits

- Gemini free-tier data handling terms differ from paid-tier terms; review Google’s current policy before use.
- Uploaded clips live briefly in R2 and Gemini Files API. The Worker attempts deletion when processing finishes; a one-day R2 lifecycle rule cleans up abandoned R2 objects. Gemini Files API also has provider-controlled retention.
- Provider request-size, video duration, codec, free-tier rate limits, and account eligibility apply. A 100 MB upload allowance does not mean every 100 MB video will be accepted or processed within free quotas.
- The app is unauthenticated and has no per-user quotas. Anyone who discovers the URL can use its free API allocation. Keep it personal or add authentication/rate limits before sharing.
- AI captions can be inaccurate. Check names, quotes, and context before posting. Captions do not guarantee reach or virality.

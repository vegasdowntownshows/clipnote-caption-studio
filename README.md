# Clipnote

A responsive caption studio for video clips. The browser checks video type and the 100 MB limit, shows a local preview, requests a short-lived signed upload URL, and sends the video directly to a private Google Cloud Storage bucket. Cloud Run downloads the object, asks Gemini to inspect the video and return five distinct caption angles, then removes the bucket object, local temporary file, and Gemini Files API upload. There is no user account or database.

## Architecture

- **Website:** Vite + React static site, deployable to Cloudflare Pages or Vercel.
- **Caption API:** FastAPI container on Google Cloud Run (scales to zero; runs independently of your computer).
- **Video understanding:** Gemini API using `gemini-2.5-flash` by default.
- **Video storage:** Private Google Cloud Storage bucket, short-lived signed PUT upload, deleted after processing. Cloud Run receives only a small JSON request; the video does not pass through Cloud Run's request-size limit.
- **Data handling:** Cloud Run enforces 100 MiB, writes a temporary local copy, and attempts object and Gemini file deletion after generation. Failed/incomplete sessions can leave a bucket object behind; configure a lifecycle rule to delete incoming objects after one day. Avoid uploading sensitive/private footage. Provider processing and retention terms apply; review current Google terms before launch.

## Required settings

Backend (Cloud Run):

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | Yes | Secret API key from Google AI Studio. Store as a Cloud Run secret; never put it in frontend settings. |
| `ALLOWED_ORIGINS` | Recommended | Comma-separated exact website origins, e.g. `https://clipnote.pages.dev,https://your-domain.com`. Defaults to `*` for initial setup. |
| `GEMINI_MODEL` | No | Model identifier; defaults to `gemini-2.5-flash`. Check model availability and pricing in your account. |
| `UPLOAD_BUCKET` | Yes | Name of the private Google Cloud Storage bucket for temporary clips. |
| `SERVICE_ACCOUNT_EMAIL` | Yes | Cloud Run runtime service account email used to sign short-lived upload URLs. Grant it bucket object permissions and `roles/iam.serviceAccountTokenCreator` on that service account for IAM signing. |

Website build setting:

| Variable | Required | Purpose |
|---|---|---|
| `VITE_API_URL` | Yes | Base HTTPS URL of the deployed Cloud Run service (no trailing `/generate`). |

## Deploy the API to Google Cloud Run

1. Create a Google Cloud project, enable billing, and enable Cloud Run, Artifact Registry, and Cloud Storage. Install and authenticate the Google Cloud CLI.
2. Create a Gemini API key in Google AI Studio. Add it to Google Secret Manager as `GEMINI_API_KEY`; do not commit it or paste it into a public setting.
3. Create a private Cloud Storage bucket in the same region as Cloud Run. Enable CORS for your final website origin and `PUT` method. Example `cors.json`:

   ```json
   [{"origin":["https://YOUR-SITE.pages.dev"],"method":["PUT"],"responseHeader":["Content-Type"],"maxAgeSeconds":3600}]
   ```

   Apply it with `gcloud storage buckets update gs://YOUR_BUCKET --cors-file=cors.json`. Add a lifecycle rule to delete objects under `incoming/` after one day as a cleanup backstop. The Cloud Run service identity needs object create, read, and delete access to this bucket, plus `roles/iam.serviceAccountTokenCreator` on itself for IAM signing. Record its email for the environment setting below.
4. From the `backend` folder, deploy the container (replace the example values):

   ```sh
   gcloud run deploy clipnote-api \
     --source . \
     --region us-central1 \
     --allow-unauthenticated \
     --memory 1Gi \
     --cpu 1 \
     --timeout 900 \
     --concurrency 2 \
     --max-instances 3 \
     --set-secrets GEMINI_API_KEY=GEMINI_API_KEY:latest \
     --set-env-vars ALLOWED_ORIGINS=https://YOUR-SITE.pages.dev,UPLOAD_BUCKET=YOUR_BUCKET,SERVICE_ACCOUNT_EMAIL=YOUR_RUNTIME_SERVICE_ACCOUNT_EMAIL
   ```

   Use the Cloud Run URL shown after deployment as `VITE_API_URL`. Public invocation is needed for a browser-only upload flow. Set `ALLOWED_ORIGINS` to the exact deployed origin(s). For an internet-facing production service, add rate limiting/abuse protection before sharing broadly; this starter intentionally has no accounts or quotas.

5. Check `https://YOUR-CLOUD-RUN-URL/health` returns `{"ok":true}`.

## Deploy the website

1. Push the `caption-studio` directory to a Git provider, or upload it through a static-host deployment flow.
2. Choose a Vite/React static project. Build command: `npm run build`; output folder: `dist`.
3. Add `VITE_API_URL` with the Cloud Run URL, then deploy. Add your final custom domain to both the hosting provider and backend `ALLOWED_ORIGINS`.
4. If the API CORS setting changes, update the Cloud Run service environment and redeploy.

For local UI development, run `npm install`, set `VITE_API_URL` in a local `.env` file, and run `npm run dev`. Local development is optional; production generation runs in Cloud Run.

## Costs and limits

This is designed for low idle cost: Cloud Run can scale to zero, and a static site host commonly has a free tier. Free quotas, maximum request duration, and billing terms vary by account, region, and change over time. Gemini API video processing is usage-billed and may not be free; video size, duration, model, and current token/audio-video pricing affect cost. A 100 MB file allowance is a maximum upload size, not a promise that every duration/codec will fit within the provider's processing limits. Check current Google Cloud Run, Gemini API, and selected hosting-provider pricing/quotas before publishing. Set billing alerts and API quotas to control spend. No monthly cost can be guaranteed by this project.

## Errors and operational notes

- Only browser-recognized video files up to 100 MiB are accepted; the API checks again.
- Unsupported formats, oversized videos, empty uploads, provider failures, and missing configuration return user-readable errors.
- The UI preview uses a local object URL and is revoked when the clip is replaced or removed.
- Gemini API credentials stay on the backend. Do not expose secrets through `VITE_` variables.
- The generated captions are suggestions, not a promise of reach or virality. Review factual details and edit into your own voice.

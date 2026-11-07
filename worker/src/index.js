const MAX_BYTES = 100_000_000;
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(x => x.trim()).filter(Boolean);
  if (origin && allowed.length && !allowed.includes(origin)) return null;
  return { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Clip-Name", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
}

async function geminiUpload(env, object) {
  const key = env.GEMINI_API_KEY;
  const type = object.httpMetadata?.contentType || "video/mp4";
  const init = await fetch(`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start", "X-Goog-Upload-Header-Content-Length": String(object.size), "X-Goog-Upload-Header-Content-Type": type },
    body: JSON.stringify({ file: { display_name: "Temporary Clipnote video" } })
  });
  if (!init.ok) throw new Error("The video provider could not start the upload.");
  const uploadUrl = init.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("The video provider did not return an upload address.");
  const uploaded = await fetch(uploadUrl, { method: "POST", headers: { "Content-Length": String(object.size), "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: object.body });
  if (!uploaded.ok) throw new Error("The video provider could not receive the clip.");
  const payload = await uploaded.json();
  if (!payload.file?.name || !payload.file?.uri) throw new Error("The video provider returned an incomplete upload.");
  return payload.file;
}

async function waitForFile(env, name) {
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`);
    if (!r.ok) throw new Error("Could not check video processing status.");
    const data = await r.json();
    if (data.state === "ACTIVE") return data;
    if (data.state === "FAILED") throw new Error("The video could not be processed. Try a shorter or more common video format.");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error("The video is taking too long to process. Please try a shorter clip.");
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env);
    if (!headers) return json({ detail: "This website origin is not allowed." }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") return json({ ok: true }, 200, headers);
    if (!env.CLIPS || !env.GEMINI_API_KEY) return json({ detail: "The caption service is not configured yet." }, 503, headers);

    if (url.pathname === "/upload" && request.method === "POST") {
      const type = request.headers.get("Content-Type") || "";
      const length = Number(request.headers.get("Content-Length") || 0);
      if (!type.startsWith("video/")) return json({ detail: "Please upload a supported video file." }, 415, headers);
      if (!length || length > MAX_BYTES) return json({ detail: "Choose a non-empty video up to 100 MB." }, 413, headers);
      const id = crypto.randomUUID();
      const name = `incoming/${id}`;
      try {
        await env.CLIPS.put(name, request.body, { httpMetadata: { contentType: type }, customMetadata: { createdAt: new Date().toISOString() } });
        return json({ object_name: name }, 200, headers);
      } catch (e) {
        console.error("R2 upload failed", e?.name);
        return json({ detail: "The video could not be stored. Please try again." }, 502, headers);
      }
    }

    if (url.pathname === "/generate" && request.method === "POST") {
      let body;
      try { body = await request.json(); } catch { return json({ detail: "Invalid request." }, 400, headers); }
      if (typeof body.object_name !== "string" || !/^incoming\/[0-9a-f-]{36}$/.test(body.object_name)) return json({ detail: "This uploaded clip is invalid or expired." }, 400, headers);
      const name = body.object_name;
      let file;
      try {
        const object = await env.CLIPS.get(name);
        if (!object) return json({ detail: "The uploaded video was not found. Please upload it again." }, 404, headers);
        if (object.size > MAX_BYTES) return json({ detail: "Choose a video up to 100 MB." }, 413, headers);
        file = await geminiUpload(env, object);
        await waitForFile(env, file.name);
        const prompt = "Watch the video and write exactly five distinct, natural social-media captions for an X clipping account. Use only details actually supported by the video; do not invent names, quotes, context, or outcomes. Make captions concise and human, with varied angles (clean hook, curiosity, human moment, conversation starter, understated observation). Optimize for clarity, relevance, and genuine engagement. Avoid hashtags unless essential, emoji clutter, generic hype, spam, false urgency, and clickbait. No claims of virality. Return only a JSON object matching this schema: {\"captions\":[{\"angle\":\"Short label\",\"text\":\"Caption text\"}]}";
        const result = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(env.GEMINI_MODEL || "gemini-2.5-flash-lite")}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ file_data: { mime_type: file.mimeType || object.httpMetadata?.contentType || "video/mp4", file_uri: file.uri } }, { text: prompt }] }], generationConfig: { responseMimeType: "application/json", temperature: 0.8 } })
        });
        if (!result.ok) throw new Error("The caption model could not analyze this clip.");
        const response = await result.json();
        const text = response.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
        const captions = JSON.parse(text).captions;
        if (!Array.isArray(captions) || captions.length !== 5 || captions.some(c => typeof c.text !== "string" || !c.text.trim())) throw new Error("The caption model returned an incomplete result.");
        return json({ captions }, 200, headers);
      } catch (e) {
        console.error("Caption generation failed", e?.name);
        return json({ detail: e?.message || "We couldn’t analyze this clip. Please try again." }, 502, headers);
      } finally {
        try { await env.CLIPS.delete(name); } catch (e) { console.error("Clip cleanup failed", e?.name); }
        if (file?.name) {
          try { await fetch(`https://generativelanguage.googleapis.com/v1beta/${file.name}?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, { method: "DELETE" }); } catch (e) { console.error("Provider file cleanup failed", e?.name); }
        }
      }
    }
    return json({ detail: "Not found." }, 404, headers);
  }
};

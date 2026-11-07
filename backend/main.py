import json
import os
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
import google.auth
from google.auth.transport.requests import Request
from google.cloud import storage
from pydantic import BaseModel

MAX_BYTES = 100 * 1024 * 1024
app = FastAPI(title="Clipnote caption service", docs_url=None, redoc_url=None)
origins = [x.strip() for x in os.getenv("ALLOWED_ORIGINS", "*").split(",") if x.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["POST", "GET", "OPTIONS"], allow_headers=["*"])
bucket_name = os.getenv("UPLOAD_BUCKET")
storage_client = storage.Client() if bucket_name else None

class UploadRequest(BaseModel):
    filename: str
    content_type: str
    size: int

class GenerateRequest(BaseModel):
    object_name: str
    content_type: str

@app.get("/health")
def health():
    return {"ok": True}

@app.post("/upload-url")
def upload_url(request: UploadRequest):
    if not storage_client or not bucket_name:
        raise HTTPException(503, "Video storage is not configured yet.")
    if not request.content_type.startswith("video/"):
        raise HTTPException(415, "Please upload a supported video file.")
    if request.size <= 0 or request.size > MAX_BYTES:
        raise HTTPException(413 if request.size > MAX_BYTES else 400, "Choose a non-empty video up to 100 MB.")
    object_name = f"incoming/{uuid.uuid4().hex}{Path(request.filename or 'clip.mp4').suffix[:12]}"
    blob = storage_client.bucket(bucket_name).blob(object_name)
    credentials, _ = google.auth.default()
    credentials.refresh(Request())
    signer_email = os.getenv("SERVICE_ACCOUNT_EMAIL") or getattr(credentials, "service_account_email", None)
    if not signer_email:
        raise HTTPException(503, "Signed upload service identity is not configured.")
    url = blob.generate_signed_url(version="v4", expiration=900, method="PUT", content_type=request.content_type, service_account_email=signer_email, access_token=credentials.token)
    return {"upload_url": url, "object_name": object_name}

@app.post("/generate")
def generate(request: GenerateRequest):
    if not storage_client or not bucket_name:
        raise HTTPException(503, "Video storage is not configured yet.")
    if not request.content_type.startswith("video/") or not request.object_name.startswith("incoming/"):
        raise HTTPException(415, "Please upload a supported video file.")
    object_name = request.object_name
    blob = storage_client.bucket(bucket_name).blob(object_name)
    if not blob.exists():
        raise HTTPException(404, "The uploaded video could not be found. Please upload it again.")
    size = blob.size or 0
    if size == 0 or size > MAX_BYTES:
        try: blob.delete()
        except Exception: pass
        raise HTTPException(413 if size > MAX_BYTES else 400, "Choose a non-empty video up to 100 MB.")
    suffix = Path(object_name).suffix[:12] or ".mp4"
    tmp_path = None
    uploaded = None
    client = None
    try:
        with tempfile.NamedTemporaryFile(prefix="clipnote-", suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
            blob.download_to_file(tmp)
        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            raise HTTPException(503, "Caption generation is not configured yet.")
        client = genai.Client(api_key=api_key)
        uploaded = client.files.upload(file=tmp_path, config=types.UploadFileConfig(mime_type=request.content_type, display_name="Temporary Clipnote video"))
        prompt = """Watch the video and write exactly five distinct, natural social-media captions for an X clipping account. Use only details actually supported by the video; do not invent names, quotes, context, or outcomes. Make captions concise and human, with varied angles (clean hook, curiosity, human moment, conversation starter, understated observation). Optimize for clarity, relevance, and genuine engagement. Avoid hashtags unless essential, emoji clutter, generic hype, spam, false urgency, and clickbait. No claims of virality. Return only a JSON object matching this schema: {\"captions\":[{\"angle\":\"Short label\",\"text\":\"Caption text\"}]}"""
        result = client.models.generate_content(model=os.getenv("GEMINI_MODEL", "gemini-2.5-flash"), contents=[uploaded, prompt], config=types.GenerateContentConfig(response_mime_type="application/json", temperature=0.8))
        try:
            data = json.loads(result.text or "")
            captions = data.get("captions", [])
            if len(captions) != 5 or any(not isinstance(c.get("text"), str) or not c["text"].strip() for c in captions):
                raise ValueError("Invalid caption response")
        except (ValueError, TypeError, AttributeError, json.JSONDecodeError):
            raise HTTPException(502, "The caption service returned an incomplete result. Please try again.")
        return {"captions": captions}
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Caption generation failed ({type(exc).__name__}): {exc}")
        raise HTTPException(502, "We couldn’t analyze this clip. Please try again.") from exc
    finally:
        if tmp_path:
            try: os.unlink(tmp_path)
            except OSError: pass
        try: blob.delete()
        except Exception as exc: print(f"Temporary storage object cleanup failed: {type(exc).__name__}")
        if uploaded and client:
            try: client.files.delete(name=uploaded.name)
            except Exception as exc: print(f"Temporary Gemini file cleanup failed: {type(exc).__name__}")

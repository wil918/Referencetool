"""Auto-tagging and description generation, powered by Claude."""
import base64
import json
import time
from io import BytesIO

from anthropic import (
    Anthropic,
    APIConnectionError,
    APITimeoutError,
    InternalServerError,
    RateLimitError,
)
from PIL import Image

from config import ANTHROPIC_API_KEY, CLAUDE_MODEL

_client = None

# Claude resizes images above this anyway, so sending them pre-resized saves
# bandwidth and avoids huge uploads from full-resolution scans/screenshots.
MAX_IMAGE_DIMENSION = 1568
MAX_IMAGE_BYTES = 4_500_000  # stay comfortably under the API's per-image limit
RETRYABLE_ERRORS = (APIConnectionError, APITimeoutError, InternalServerError, RateLimitError)


def get_client():
    global _client
    if _client is None:
        if not ANTHROPIC_API_KEY:
            raise RuntimeError(
                "ANTHROPIC_API_KEY is not set. Copy .env.example to .env "
                "and add your key from console.anthropic.com."
            )
        _client = Anthropic(api_key=ANTHROPIC_API_KEY)
    return _client


def _prepare_image_b64(path):
    """Load an image, downscale/compress it if needed, return (b64_data, mime_type).

    Large scanned pages or screenshots can otherwise produce base64 payloads
    big enough to cause connection failures before the API even returns a
    proper error -- this keeps every outgoing image well under those limits.
    The original file on disk is untouched; this only affects what's sent
    to Claude for tagging.
    """
    img = Image.open(path)
    img = img.convert("RGB")

    if max(img.size) > MAX_IMAGE_DIMENSION:
        img.thumbnail((MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION), Image.LANCZOS)

    quality = 90
    data = None
    while True:
        buffer = BytesIO()
        img.save(buffer, format="JPEG", quality=quality)
        data = buffer.getvalue()
        if len(data) <= MAX_IMAGE_BYTES or quality <= 40:
            break
        quality -= 15

    return base64.standard_b64encode(data).decode("utf-8"), "image/jpeg"


def _create_with_retry(client, max_attempts=4, **kwargs):
    last_err = None
    for attempt in range(max_attempts):
        try:
            return client.messages.create(**kwargs)
        except RETRYABLE_ERRORS as e:
            last_err = e
            if attempt == max_attempts - 1:
                break
            wait = 2**attempt
            print(f"  connection issue ({type(e).__name__}), retrying in {wait}s...")
            time.sleep(wait)
    raise last_err


TAGGING_INSTRUCTIONS = """You are helping catalog references for a fashion design research library.
Look at the attached reference and respond with ONLY a JSON object (no other text, no markdown
fences) in exactly this shape:
{
  "title": "a short, descriptive caption-style title (3-6 words) for what this actually shows",
  "tags": ["short-tag-1", "short-tag-2", ...],
  "description": "one or two sentence description, focused on visual/design-relevant qualities"
}
Tags should be short (1-3 words), lowercase, and where relevant cover: garment type, silhouette,
era/movement, color/material, mood, and design concepts. Aim for 6-10 tags. The title should read
like a museum caption or mood-board label, not a filename -- avoid generic words like "image",
"photo", or "reference"."""


def tag_image(image_path):
    client = get_client()
    image_data, mime_type = _prepare_image_b64(image_path)

    response = _create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=500,
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": mime_type,
                            "data": image_data,
                        },
                    },
                    {"type": "text", "text": TAGGING_INSTRUCTIONS},
                ],
            }
        ],
    )
    return _parse_response(response)


def tag_text(text, title=None):
    client = get_client()
    prompt = TAGGING_INSTRUCTIONS + "\n\nHere is the reference text"
    if title:
        prompt += f' (titled "{title}")'
    prompt += f":\n\n{text[:8000]}"

    response = _create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=500,
        messages=[{"role": "user", "content": prompt}],
    )
    return _parse_response(response)


def tag_pdf(text, image_paths, title=None):
    """Tag a PDF using both its extracted text and its embedded images together,
    so a tearsheet or lookbook page isn't reduced to just its captions."""
    client = get_client()
    content = []
    for img_path in image_paths:
        image_data, mime_type = _prepare_image_b64(img_path)
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": mime_type, "data": image_data},
            }
        )

    prompt = TAGGING_INSTRUCTIONS + (
        "\n\nThis reference is a PDF. You're shown its most significant embedded "
        "images plus its extracted text -- consider both together, since the "
        "images often carry more design-relevant information than the text."
    )
    if title:
        prompt += f' It is titled "{title}".'
    prompt += f"\n\nExtracted text:\n{text[:6000] if text and text.strip() else '(no extractable text)'}"

    content.append({"type": "text", "text": prompt})

    response = _create_with_retry(
        client,
        model=CLAUDE_MODEL,
        max_tokens=500,
        messages=[{"role": "user", "content": content}],
    )
    return _parse_response(response)


def _parse_response(response):
    raw = "".join(block.text for block in response.content if block.type == "text").strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        raw = raw[4:] if raw.startswith("json") else raw
    raw = raw.strip()
    try:
        data = json.loads(raw)
        return data.get("title", ""), data.get("tags", []), data.get("description", "")
    except json.JSONDecodeError:
        # Fall back gracefully rather than crashing an ingest over a formatting slip.
        return "", [], raw

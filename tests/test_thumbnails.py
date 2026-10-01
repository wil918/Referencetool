"""Thumbnail cache: generated once per content hash, shared by identical
bytes, invalidated by a changed hash, and harmless to delete and regenerate.
See thumbnails.py -- this follows the same derived-data shape as
colour_analysis (hard rule 8), just on disk instead of in a table.
"""
import io
import shutil

from PIL import Image

import config
import db
import ingest
import thumbnails


def jpeg_bytes(size=(1200, 900), colour=(180, 40, 40)):
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "JPEG")
    return buf.getvalue()


def transparent_png_bytes(size=(600, 400)):
    """An RGBA image with a genuinely transparent region, not just an alpha
    channel that happens to be all 255 -- _has_transparency has to tell
    those apart, and this is what exercises the "really transparent" path."""
    img = Image.new("RGBA", size, (10, 10, 10, 255))
    for x in range(50):
        for y in range(50):
            img.putpixel((x, y), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def opaque_png_bytes(size=(600, 400)):
    buf = io.BytesIO()
    Image.new("RGBA", size, (20, 90, 160, 255)).save(buf, "PNG")
    return buf.getvalue()


def add_image(archive, name, data, ext=".jpg", force=False):
    path = archive / f"{name}{ext}"
    path.write_bytes(data)
    result = ingest.add_reference(path, title=name, force=force)
    return db.get_reference(result["id"])


# --- the cache itself --------------------------------------------------


def test_thumbnail_is_resized_and_cached_on_disk(archive):
    ref = add_image(archive, "big", jpeg_bytes(size=(1200, 900)))
    original = config.REFERENCES_DIR / ref["filepath"]

    cache_path, mimetype = thumbnails.thumbnail_for(original, ref["content_hash"])

    assert cache_path.exists()
    assert cache_path.is_relative_to(config.THUMBNAILS_DIR)
    assert mimetype == "image/jpeg"
    with Image.open(cache_path) as thumb:
        assert max(thumb.size) <= thumbnails.MAX_EDGE


def test_thumbnail_generated_once_and_reused(archive):
    ref = add_image(archive, "big", jpeg_bytes())
    original = config.REFERENCES_DIR / ref["filepath"]

    first_path, _ = thumbnails.thumbnail_for(original, ref["content_hash"])
    first_mtime = first_path.stat().st_mtime_ns

    second_path, _ = thumbnails.thumbnail_for(original, ref["content_hash"])

    assert second_path == first_path
    # Untouched, not rewritten -- the second call must be a pure cache hit
    # that never opens the original again.
    assert second_path.stat().st_mtime_ns == first_mtime
    assert len(list(config.THUMBNAILS_DIR.iterdir())) == 1


def test_identical_bytes_share_one_cache_entry(archive):
    data = jpeg_bytes(colour=(50, 120, 90))
    ref_a = add_image(archive, "one", data)
    ref_b = add_image(archive, "two", data, force=True)  # same bytes, forced past dedupe

    assert ref_a["content_hash"] == ref_b["content_hash"]

    path_a, _ = thumbnails.thumbnail_for(config.REFERENCES_DIR / ref_a["filepath"], ref_a["content_hash"])
    path_b, _ = thumbnails.thumbnail_for(config.REFERENCES_DIR / ref_b["filepath"], ref_b["content_hash"])

    assert path_a == path_b
    assert len(list(config.THUMBNAILS_DIR.iterdir())) == 1


def test_changed_content_hash_produces_a_new_thumbnail(archive):
    """Stands in for session A6's rotate: same reference, new bytes, new
    content_hash -- the old thumbnail must not be handed back as if nothing
    had changed."""
    ref = add_image(archive, "photo", jpeg_bytes(colour=(200, 200, 200)))
    original = config.REFERENCES_DIR / ref["filepath"]

    before_path, _ = thumbnails.thumbnail_for(original, ref["content_hash"])

    rotated = Image.open(original).rotate(90, expand=True)
    rotated.save(original, "JPEG")
    new_hash = ingest._file_hash(original)
    assert new_hash != ref["content_hash"]

    after_path, _ = thumbnails.thumbnail_for(original, new_hash)

    assert after_path != before_path
    assert before_path.exists()  # the stale entry is just unreferenced, not corrupted
    assert after_path.exists()


def test_missing_content_hash_falls_back_to_hashing_the_file(archive):
    """A row that predates the content_hash column (or one a caller just
    doesn't have it for) still gets a correct, cacheable thumbnail -- keyed
    by the file's own hash instead of a stored one."""
    ref = add_image(archive, "legacy", jpeg_bytes())
    original = config.REFERENCES_DIR / ref["filepath"]

    no_hash_path, _ = thumbnails.thumbnail_for(original, content_hash=None)
    with_hash_path, _ = thumbnails.thumbnail_for(original, ref["content_hash"])

    assert no_hash_path == with_hash_path  # same bytes, same key, regardless of how it got there


def test_transparency_is_preserved_as_png_and_opacity_as_jpeg(archive):
    transparent_ref = add_image(archive, "logo", transparent_png_bytes(), ext=".png")
    opaque_ref = add_image(archive, "swatch", opaque_png_bytes(), ext=".png")

    _, transparent_mime = thumbnails.thumbnail_for(
        config.REFERENCES_DIR / transparent_ref["filepath"], transparent_ref["content_hash"]
    )
    _, opaque_mime = thumbnails.thumbnail_for(
        config.REFERENCES_DIR / opaque_ref["filepath"], opaque_ref["content_hash"]
    )

    assert transparent_mime == "image/png"
    assert opaque_mime == "image/jpeg"  # no real transparency -- JPEG is smaller


def test_deleting_the_cache_directory_is_harmless(archive):
    ref = add_image(archive, "big", jpeg_bytes())
    original = config.REFERENCES_DIR / ref["filepath"]
    thumbnails.thumbnail_for(original, ref["content_hash"])

    shutil.rmtree(config.THUMBNAILS_DIR)

    cache_path, mimetype = thumbnails.thumbnail_for(original, ref["content_hash"])

    assert cache_path.exists()
    assert mimetype == "image/jpeg"


# --- through the HTTP route ---------------------------------------------


def test_media_route_still_returns_the_original_at_full_size(client, archive):
    ref = add_image(archive, "big", jpeg_bytes(size=(1200, 900)))

    res = client.get(f"/media/{ref['id']}")

    assert res.status_code == 200
    with Image.open(io.BytesIO(res.data)) as img:
        assert img.size == (1200, 900)


def test_thumb_route_serves_a_resized_cacheable_image(client, archive):
    ref = add_image(archive, "big", jpeg_bytes(size=(1200, 900)))

    res = client.get(f"/media/{ref['id']}/thumb")

    assert res.status_code == 200
    with Image.open(io.BytesIO(res.data)) as img:
        assert max(img.size) <= thumbnails.MAX_EDGE

    assert "max-age=31536000" in res.headers["Cache-Control"]
    assert "immutable" in res.headers["Cache-Control"]
    assert res.headers.get("ETag")


def test_thumb_route_etag_is_stable_and_honours_if_none_match(client, archive):
    ref = add_image(archive, "big", jpeg_bytes())

    first = client.get(f"/media/{ref['id']}/thumb")
    etag = first.headers["ETag"]

    second = client.get(f"/media/{ref['id']}/thumb", headers={"If-None-Match": etag})

    assert second.status_code == 304

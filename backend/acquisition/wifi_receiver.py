"""
wifi_receiver.py  —  WiFi streaming upload handler  (fixed v3)
─────────────────────────────────────────────────────────────────────────────
DROP-IN REPLACEMENT for acquisition/wifi_receiver.py.

Changes from v2:
  - Uploads are now buffered to data/incoming/wifi_staging/ instead of
    data/incoming/ directly. acquisition/watcher.py watches data/incoming/
    with recursive=False, so files written straight into data/incoming/
    are ALSO picked up by the watcher, which spins up a SECOND
    IngestSession for the same file (patient_id parsed from filename).
    Whichever session finishes first can move/delete the file out from
    under the other session's parser thread mid-read, which manifests as:

        [T2-parser] EDF header not received within 60s

    Writing into a wifi_staging/ subfolder makes the file invisible to
    the non-recursive watcher, so only the IngestSession created here
    ever touches it.

The device sends:
  POST http://<laptop-ip>:5000/upload
  Headers:
    Content-Type:   application/octet-stream
    Content-Length: <total bytes>
    X-Patient-Id:   P004
    X-Filename:     P004_20min_3lead.edf
  Body: raw EDF bytes

Response is returned AFTER the file is fully received (buffering takes
~1s for a 20-min file over LAN). Client then polls
GET /api/transfer/status/<session_id> for parse/write progress.
"""

import os
import re
import uuid
import logging
import threading

from flask import Blueprint, request, jsonify

log = logging.getLogger(__name__)

wifi_bp = Blueprint("wifi", __name__)

# Active sessions: session_id → IngestSession
_active: dict  = {}
_lock          = threading.Lock()

_STREAM_CHUNK  = 65536   # 64 KB — matches device send size


# ── Safe incoming directory ───────────────────────────────────────────────────

def _incoming_dir() -> str:
    """
    Returns <project_root>/data/incoming/wifi_staging/  — always an ASCII path.

    IMPORTANT: this is a SUBFOLDER of data/incoming/, not data/incoming/
    itself. acquisition/watcher.py watches data/incoming/ with
    recursive=False, so anything written directly into data/incoming/
    also gets picked up by the watcher and turned into a SECOND,
    competing IngestSession for the same file. That second session can
    move/delete the file out from under our parser mid-read, which
    surfaces as "[T2-parser] EDF header not received within 60s".

    Writing into a subfolder keeps WiFi uploads invisible to the
    watcher, since wifi_receiver.py already creates its own
    IngestSession directly — no need for the watcher to also handle it.
    """
    base = os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "data", "incoming", "wifi_staging")
    )
    os.makedirs(base, exist_ok=True)
    return base


def _safe_filename(raw: str, patient_id: str) -> str:
    """
    Sanitise the filename supplied by the device:
      - Strip directory separators (security)
      - Replace any character that is not alphanumeric, dash, dot, or
        underscore with '_'  (avoids WinError 123 from special chars)
      - Guarantee a .edf extension
      - Guarantee the patient_id prefix so watcher.py can parse it
    """
    name = os.path.basename(raw).strip()
    name = re.sub(r"[^\w.\-]", "_", name)   # replace unsafe chars
    name = name.strip("._")                 # strip leading/trailing dots

    if not name:
        name = f"{patient_id}_upload.edf"
    elif not name.lower().endswith((".edf", ".edf+")):
        name += ".edf"

    # Prefix patient_id if not already present (watcher.py needs it)
    if not name.upper().startswith(patient_id.upper()):
        name = f"{patient_id}_{name}"

    return name


# ── /upload ───────────────────────────────────────────────────────────────────

@wifi_bp.post("/upload")
def upload():
    """
    Receive a streaming EDF upload from the Holter device / phone simulator.

    Strategy
    ────────
    1. Read patient metadata from request headers.
    2. Buffer the raw byte stream to data/incoming/wifi_staging/<safe_filename>.
       This is an ASCII path → no WinError 123, and a subfolder the
       watcher does not poll → no double-IngestSession race.
    3. Create IngestSession(source_path=<that file>).
       The existing 3-thread pipeline (file-reader → parser → writer) runs
       exactly as it does for SD/USB/BT sources.
    4. Return session_id so the client can poll progress.
    """

    # ── 1. Metadata ───────────────────────────────────────────────────────────
    patient_id = (
        request.headers.get("X-Patient-Id",  "").strip()
        or request.headers.get("x-patient-id", "").strip()
        or request.args.get("patient_id",      "").strip()
        or "UNKNOWN"
    )

    raw_fname = (
        request.headers.get("X-Filename",  "").strip()
        or request.headers.get("x-filename", "").strip()
        or f"{patient_id}_upload.edf"
    )
    safe_fname = _safe_filename(raw_fname, patient_id)

    try:
        bytes_total = int(request.headers.get("Content-Length", 0))
    except (ValueError, TypeError):
        bytes_total = 0

    log.info(
        f"[WiFi upload] patient={patient_id}"
        f"  file={safe_fname}"
        f"  size={bytes_total/1e6:.1f}MB"
    )

    # ── 2. Buffer stream → data/incoming/wifi_staging/<safe_fname> ────────────
    dest_path = os.path.join(
        _incoming_dir(),
        f"wifi_{uuid.uuid4().hex[:8]}_{safe_fname}",   # uuid prefix = no collisions
    )

    bytes_received = 0
    try:
        with open(dest_path, "wb") as fout:
            for chunk in _iter_stream(request):
                fout.write(chunk)
                bytes_received += len(chunk)
    except Exception as e:
        log.error(f"[WiFi upload] Write error after {bytes_received} bytes: {e}")
        _cleanup(dest_path)
        return jsonify({"success": False, "error": f"Stream write failed: {e}"}), 500

    if bytes_received == 0:
        log.warning("[WiFi upload] Received 0 bytes — rejecting")
        _cleanup(dest_path)
        return jsonify({"success": False, "error": "Empty upload"}), 400

    log.info(
        f"[WiFi upload] Stream complete: {bytes_received/1e6:.1f}MB"
        f"  → {dest_path}"
    )

    # ── 3. Hand off to IngestSession (file-based path) ────────────────────────
    try:
        from acquisition.ingest_stream import IngestSession

        session = IngestSession(
            patient_id    = patient_id,
            source_path   = dest_path,      # ← ASCII path, pyedflib happy
            bytes_total   = bytes_received,
            source_method = "wifi",
        )
    except Exception as e:
        log.error(f"[WiFi upload] IngestSession failed: {e}")
        _cleanup(dest_path)
        return jsonify({"success": False, "error": f"Ingest init failed: {e}"}), 500

    with _lock:
        _active[session.session_id] = session

    log.info(
        f"[WiFi upload] IngestSession started"
        f"  session={session.session_id[:8]}"
        f"  patient={patient_id}"
    )

    return jsonify({
        "success":        True,
        "session_id":     session.session_id,
        "patient_id":     patient_id,
        "bytes_received": bytes_received,
        "message":        "File received. ECG processing in background.",
        "status_url":     f"/api/transfer/status/{session.session_id}",
    }), 200


@wifi_bp.get("/upload/status")
def upload_status_list():
    """List all active WiFi upload sessions."""
    from acquisition.progress_store import list_active
    return jsonify(list_active())


# ── Helpers ───────────────────────────────────────────────────────────────────

def _iter_stream(req):
    """Yield 64 KB chunks from the Flask request stream."""
    stream = req.stream
    while True:
        chunk = stream.read(_STREAM_CHUNK)
        if not chunk:
            break
        yield chunk


def _cleanup(path: str):
    """Remove a partial file silently."""
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except Exception:
        pass
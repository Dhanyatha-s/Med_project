"""
wifi_receiver.py  —  WiFi streaming upload handler
─────────────────────────────────────────────────────────────────────────────
Flask Blueprint that receives an EDF file streamed from the Holter device
via HTTP POST. Feeds chunks directly into IngestSession.feed() as they arrive.

The device sends:
  POST http://<laptop-ip>:5000/upload
  Headers:
    Content-Type:   application/octet-stream
    Content-Length: <total bytes>
    X-Patient-Id:   P001
    X-Filename:     recording.edf
  Body: raw EDF bytes, streamed

The response is returned IMMEDIATELY after the session is created — before
the transfer completes. The client then polls GET /api/transfer/status/<session_id>.

Register in api.py:
    from acquisition.wifi_receiver import wifi_bp
    app.register_blueprint(wifi_bp)
"""

import os
import logging
from flask import Blueprint, request, jsonify
from acquisition.ingest_stream import IngestSession

log = logging.getLogger(__name__)

wifi_bp = Blueprint("wifi", __name__)

# Active WiFi sessions keyed by session_id
# These are also tracked by progress_store but we keep refs here for feed()
_active: dict = {}

_STREAM_CHUNK = 65536   # 64 KB read size from request stream


@wifi_bp.post("/upload")
def upload():
    """
    Receive streaming EDF upload from Holter device.

    Returns session_id immediately so client can poll progress.
    The transfer continues in the background after this response.
    """
    patient_id    = request.headers.get("X-Patient-Id", "UNKNOWN").strip()
    filename      = request.headers.get("X-Filename",   "upload.edf").strip()
    content_len   = request.headers.get("Content-Length", "0")

    try:
        bytes_total = int(content_len)
    except ValueError:
        bytes_total = 0

    if not filename.lower().endswith((".edf", ".edf+")):
        return jsonify({
            "success": False,
            "error":   "Only .edf files accepted"
        }), 400

    log.info(
        f"[WiFi upload] patient={patient_id}  file={filename}  "
        f"size={bytes_total/1e6:.1f}MB"
    )

    # Create ingest session (no source_path — we feed() it manually)
    session = IngestSession(
        patient_id    = patient_id,
        source_path   = None,
        bytes_total   = bytes_total,
        source_method = "wifi",
    )
    _active[session.session_id] = session

    # Stream the request body chunk by chunk into the session
    # This runs in the Flask request thread — no extra thread needed
    bytes_received = 0
    try:
        for chunk in _read_stream(request):
            session.feed(chunk)
            bytes_received += len(chunk)
    except Exception as e:
        log.error(f"[WiFi upload] Stream error after {bytes_received} bytes: {e}")
        session.cancel()
        return jsonify({
            "success":    False,
            "session_id": session.session_id,
            "error":      str(e),
        }), 500

    # Signal parser that all bytes have arrived
    session._parser.set_total_bytes(bytes_received)
    session._parser.feed_complete()

    log.info(
        f"[WiFi upload] Stream complete: {bytes_received/1e6:.1f}MB received  "
        f"session={session.session_id[:8]}"
    )

    return jsonify({
        "success":    True,
        "session_id": session.session_id,
        "patient_id": patient_id,
        "bytes_received": bytes_received,
        "message":    "Transfer complete. ECG processing in background.",
        "status_url": f"/api/transfer/status/{session.session_id}",
    }), 200


@wifi_bp.get("/upload/status")
def upload_status_list():
    """List all active WiFi upload sessions."""
    from acquisition.progress_store import list_active
    return jsonify(list_active())


def _read_stream(req):
    """
    Generator that yields 64KB chunks from the Flask request stream.
    Handles both chunked-transfer-encoding and fixed Content-Length requests.
    """
    stream = req.stream
    while True:
        chunk = stream.read(_STREAM_CHUNK)
        if not chunk:
            break
        yield chunk

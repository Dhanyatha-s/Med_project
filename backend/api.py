"""
api.py  —  Holter ECG REST API  (v8 — full acquisition integration)
─────────────────────────────────────────────────────────────────────────────
Endpoint map (all routes):

  System
    GET  /health                          — liveness + H5 inventory
    GET  /api/network/ip                  — LAN IP for Holter device config

  Data acquisition
    POST /upload                          — WiFi streaming EDF upload
    GET  /upload/status                   — list active WiFi sessions
    GET  /api/transfer/status/<session_id>— poll any session (wifi/usb/sd)
    GET  /api/transfer/recent             — last 20 sessions
    GET  /api/transfer/active             — all non-complete sessions

    GET  /api/usb/ports                   — list serial ports (★ = likely Holter)
    GET  /api/usb/status                  — USB listener state
    POST /api/usb/connect                 — start USB listener {port?, patient_id?, baud?}
    POST /api/usb/disconnect              — stop USB listener

    GET  /api/bt/status                   — BT receiver state
    GET  /api/bt/devices                  — paired BT devices (Linux/Windows)
    POST /api/bt/start                    — start BT watcher {receive_folder?, patient_id?}
    POST /api/bt/stop                     — stop BT watcher

  ECG data
    GET  /api/ecg/<patient_id>            — main ECG endpoint (dynamic leads)
                                            ?start=<sec>&duration=<sec>
    GET  /api/ecg/<patient_id>/<n>/all    — legacy all-leads (backward compat)
    GET  /api/ecg/<patient_id>/<n>        — legacy single-lead (backward compat)
    GET  /api/files                       — list all H5 files with metadata

  Patients
    GET  /api/patients                    — list all patients
    GET  /api/patients/<id>               — single patient record
    PATCH/api/patients/<id>               — update name/age/sex/dob
    POST /api/import                      — multipart EDF upload → ingest

api.py  —  Holter ECG REST API  (v9 — auto patient registration)
─────────────────────────────────────────────────────────────────────────────
Changes from v8:
  - /api/import now auto-registers ANY new patient (INSERT OR IGNORE + UPDATE)
  - Boot scan registers ALL patients found on disk automatically
  - Fixed double-prefix bug: P003_P003_holter.edf → P003_holter.edf
  - No manual sqlite commands ever needed again
"""

import os
import glob
import json
import socket
import logging

import h5py
import numpy as np
from flask import Flask, jsonify, request, abort
from flask_cors import CORS

from database import initialize_database, fetch_all_patients, fetch_patient, \
                     upsert_patient_files, auto_register_patient
from acquisition.watcher       import run_watcher
from acquisition.wifi_receiver import wifi_bp
from acquisition.progress_store import get as ps_get, list_active, list_recent
from acquisition.usb_serial    import make_usb_blueprint, start_usb_listener, \
                                        stop_usb_listener, get_usb_status, list_ports
from acquisition.bt_receiver   import make_bt_blueprint, start_bt_watcher, \
                                        stop_bt_watcher, get_bt_status

logging.basicConfig(
    level   = logging.INFO,
    format  = "%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

# ── Data directory resolution ─────────────────────────────────────────────────

def _find_data_dir() -> str:
    candidates = [
        os.environ.get("ECG_DATA_DIR", ""),
        os.path.join(os.path.dirname(__file__), "..", "data"),
        os.path.join(os.path.dirname(__file__), "data"),
        os.path.dirname(__file__),
    ]
    for c in candidates:
        c = os.path.normpath(c)
        if c and os.path.isdir(c):
            h5s = glob.glob(os.path.join(c, "**", "*.h5"), recursive=True)
            if h5s:
                log.info(f"DATA_DIR → {c}  ({len(h5s)} .h5 files)")
                return c
    fallback = os.path.normpath(
        os.path.join(os.path.dirname(__file__), "..", "data")
    )
    log.warning(f"No .h5 files found — data dir: {fallback}")
    return fallback


DATA_DIR = _find_data_dir()
PORT     = int(os.environ.get("PORT", 5000))

# ── Standard lead names by column count ──────────────────────────────────────

STANDARD_LEAD_NAMES = {
    1:  ["II"],
    2:  ["I", "II"],
    3:  ["I", "II", "V2"],
    4:  ["I", "II", "III", "V2"],
    5:  ["I", "II", "III", "aVR", "V2"],
    6:  ["I", "II", "III", "aVR", "aVL", "aVF"],
    7:  ["I", "II", "III", "aVR", "aVL", "aVF", "V1"],
    8:  ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2"],
    9:  ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3"],
    10: ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4"],
    11: ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5"],
    12: ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5", "V6"],
}

# ── H5 file handle cache ──────────────────────────────────────────────────────

_h5_cache: dict = {}


def _open_h5(path: str):
    path = os.path.normpath(path)
    if path not in _h5_cache:
        if not os.path.exists(path):
            log.warning(f"H5 not found: {path}")
            return None
        try:
            _h5_cache[path] = h5py.File(path, "r")
            log.info(f"Opened H5: {path}  shape={_h5_cache[path]['ecg'].shape}")
        except Exception as e:
            log.error(f"Cannot open {path}: {e}")
            return None
    return _h5_cache[path]


def _invalidate_h5(path: str):
    path = os.path.normpath(path)
    fh = _h5_cache.pop(path, None)
    if fh:
        try:
            fh.close()
        except Exception:
            pass


def _get_lead_names(fh) -> list[str]:
    try:
        raw = fh.attrs.get("lead_names")
        if raw is None:
            try:
                raw = fh["metadata"].attrs.get("lead_names")
            except Exception:
                pass
        if raw:
            names = json.loads(raw) if isinstance(raw, str) else list(raw)
            if isinstance(names, list) and len(names) == fh["ecg"].shape[1]:
                return [str(n) for n in names]
    except Exception:
        pass
    n = int(fh["ecg"].shape[1])
    return STANDARD_LEAD_NAMES.get(n, [f"Ch{i+1}" for i in range(n)])


def _best_h5_for_patient(patient_id: str):
    patient = fetch_patient(patient_id)

    if patient:
        for key in ("h5_12lead", "h5_3lead"):
            fname = patient.get(key, "")
            if fname:
                for candidate in [
                    os.path.join(DATA_DIR, fname),
                    fname,
                    os.path.join(DATA_DIR, "patients", patient_id, "ecg.h5"),
                ]:
                    fh = _open_h5(candidate)
                    if fh is not None:
                        return fh, _get_lead_names(fh), patient

    pat_dir = os.path.join(DATA_DIR, "patients", patient_id)
    if os.path.isdir(pat_dir):
        for fname in sorted(os.listdir(pat_dir), reverse=True):
            if fname.endswith(".h5"):
                fh = _open_h5(os.path.join(pat_dir, fname))
                if fh is not None:
                    return fh, _get_lead_names(fh), patient or {"id": patient_id, "name": patient_id}

    best_fh, best_names = None, []
    for root, _, files in os.walk(DATA_DIR):
        for fname in sorted(files):
            if not fname.endswith(".h5"):
                continue
            fh = _open_h5(os.path.join(root, fname))
            if fh is None:
                continue
            names = _get_lead_names(fh)
            if len(names) > len(best_names):
                best_fh, best_names = fh, names

    return best_fh, best_names, patient or {"id": patient_id, "name": patient_id}


def _get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


# ── Flask app ─────────────────────────────────────────────────────────────────

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

app.register_blueprint(wifi_bp)
app.register_blueprint(make_usb_blueprint())
app.register_blueprint(make_bt_blueprint())


# ══════════════════════════════════════════════════════════════════════════════
# SYSTEM
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    h5_files = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
    return jsonify({
        "status":   "ok",
        "version":  "v9",
        "data_dir": DATA_DIR,
        "lan_ip":   _get_lan_ip(),
        "port":     PORT,
        "h5_count": len(h5_files),
        "h5_files": [os.path.relpath(f, DATA_DIR) for f in h5_files],
    })


@app.get("/api/network/ip")
def network_ip():
    return jsonify({"ip": _get_lan_ip()})


# ══════════════════════════════════════════════════════════════════════════════
# TRANSFER STATUS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/transfer/status/<session_id>")
def transfer_status(session_id):
    s = ps_get(session_id)
    if not s:
        abort(404, f"Session {session_id} not found")
    return jsonify(s)


@app.get("/api/transfer/active")
def transfer_active():
    return jsonify(list_active())


@app.get("/api/transfer/recent")
def transfer_recent():
    limit = min(int(request.args.get("limit", 20)), 100)
    return jsonify(list_recent(limit))


# ══════════════════════════════════════════════════════════════════════════════
# USB / BT STATUS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/usb/ports")
def usb_ports():
    return jsonify(list_ports())


@app.get("/api/usb/status")
def usb_status():
    return jsonify(get_usb_status())


@app.get("/api/bt/status")
def bt_status():
    return jsonify(get_bt_status())


# ══════════════════════════════════════════════════════════════════════════════
# ECG DATA
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/ecg/<patient_id>")
def get_ecg_dynamic(patient_id):
    start    = float(request.args.get("start",    0))
    duration = min(float(request.args.get("duration", 10)), 30.0)

    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        available = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
        return jsonify({
            "error":     f"No H5 file found for patient {patient_id}",
            "data_dir":  DATA_DIR,
            "available": [os.path.relpath(f, DATA_DIR) for f in available],
        }), 404

    sr    = int(fh.attrs.get("sampling_rate", 250))
    total = int(fh["ecg"].shape[0])
    s     = max(0, int(start * sr))
    e     = min(s + int(duration * sr), total)

    if s >= total:
        return jsonify({"error": f"start={start}s beyond recording end"}), 400

    block     = fh["ecg"][s:e, :]
    leads_out = {
        name: block[:, i].tolist()
        for i, name in enumerate(lead_names)
        if i < block.shape[1]
    }

    log.info(f"ECG {patient_id} leads={lead_names} t=[{start:.1f},{start+duration:.1f}]s")
    return jsonify({
        "patient_id": patient_id,
        "lead_names": lead_names,
        "n_leads":    len(lead_names),
        "sr":         sr,
        "start":      start,
        "duration":   duration,
        "total_sec":  round(total / sr, 2),
        "leads":      leads_out,
    })


@app.get("/api/ecg/<patient_id>/<int:n_leads>/all")
def get_all_leads_legacy(patient_id, n_leads):
    start    = float(request.args.get("start",    0))
    duration = min(float(request.args.get("duration", 10)), 30.0)
    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        abort(404)
    sr    = int(fh.attrs.get("sampling_rate", 250))
    total = int(fh["ecg"].shape[0])
    s     = max(0, int(start * sr))
    e     = min(s + int(duration * sr), total)
    block = fh["ecg"][s:e, :]
    leads_out = {
        name: block[:, i].tolist()
        for i, name in enumerate(lead_names)
        if i < block.shape[1]
    }
    return jsonify({
        "n_leads": len(lead_names), "lead_names": lead_names,
        "sr": sr, "start": start, "duration": duration,
        "total_sec": round(total / sr, 2), "leads": leads_out,
    })


@app.get("/api/ecg/<patient_id>/<int:n_leads>")
def get_single_lead_legacy(patient_id, n_leads):
    lead     = request.args.get("lead", "II")
    start    = float(request.args.get("start",    0))
    duration = min(float(request.args.get("duration", 10)), 60.0)
    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        abort(404)
    if lead not in lead_names:
        abort(400, f"Lead '{lead}' not in file. Available: {lead_names}")
    col   = lead_names.index(lead)
    sr    = int(fh.attrs.get("sampling_rate", 250))
    total = int(fh["ecg"].shape[0])
    s     = max(0, int(start * sr))
    e     = min(s + int(duration * sr), total)
    return jsonify({
        "lead": lead, "sr": sr, "start": start,
        "total_sec": round(total / sr, 2),
        "samples": fh["ecg"][s:e, col].tolist(),
    })


@app.get("/api/files")
def list_files():
    results = []
    for fpath in sorted(glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)):
        fh = _open_h5(fpath)
        if fh is None:
            continue
        names  = _get_lead_names(fh)
        shape  = fh["ecg"].shape
        sr     = int(fh.attrs.get("sampling_rate", 250))
        results.append({
            "filename":      os.path.relpath(fpath, DATA_DIR),
            "n_leads":       len(names),
            "lead_names":    names,
            "sr":            sr,
            "total_samples": int(shape[0]),
            "duration_hr":   round(shape[0] / sr / 3600, 3),
            "duration_sec":  round(shape[0] / sr, 1),
            "size_mb":       round(os.path.getsize(fpath) / 1024 / 1024, 1),
            "status":        str(fh.attrs.get("status", "unknown")),
        })
    return jsonify(results)


# ══════════════════════════════════════════════════════════════════════════════
# PATIENTS
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/patients")
def list_patients():
    return jsonify(fetch_all_patients())


@app.route("/api/patients/<patient_id>", methods=["GET", "PATCH"])
def patient_detail(patient_id):
    if request.method == "GET":
        p = fetch_patient(patient_id)
        if not p:
            abort(404, f"Patient {patient_id} not found")
        return jsonify(p)

    data    = request.get_json(force=True, silent=True) or {}
    allowed = {"name", "age", "sex", "dob", "created_at"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify({"error": "Allowed fields: name, age, sex, dob, created_at"}), 400

    try:
        from database import get_conn
        with get_conn() as conn:
            sets = ", ".join(f"{k}=?" for k in updates)
            vals = list(updates.values()) + [patient_id]
            conn.execute(f"UPDATE patients SET {sets} WHERE id=?", vals)
            conn.commit()
        updated = fetch_patient(patient_id)
        if not updated:
            abort(404)
        return jsonify(updated)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/import")
def import_edf():
    """
    Receive EDF from phone (WiFi/BT/USB), ingest it, and
    AUTO-REGISTER the patient in holter.db.

    Flow:
        Phone sends EDF
            → saved to data/incoming/
            → parser.ingest_edf() → data/patients/PXXX/ecg.h5
            → auto_register_patient() → INSERT OR IGNORE + UPDATE in DB
            → patient appears in Records UI instantly
    """
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No 'file' field"}), 400

    patient_id = request.form.get("patient_id", "UNKNOWN").strip()
    file       = request.files["file"]

    if not file.filename.lower().endswith((".edf", ".edf+")):
        return jsonify({"success": False, "error": "File must be .edf"}), 400

    # ── Save to incoming/ (fix double-prefix bug) ─────────────────────────────
    incoming_dir = os.path.join(DATA_DIR, "incoming")
    os.makedirs(incoming_dir, exist_ok=True)
    fname      = file.filename
    safe_name  = fname if fname.upper().startswith(patient_id.upper()) \
                       else f"{patient_id}_{fname}"
    saved_path = os.path.join(incoming_dir, safe_name)
    file.save(saved_path)
    log.info(f"EDF saved: {saved_path}  patient={patient_id}")

    # ── Ingest ────────────────────────────────────────────────────────────────
    try:
        from parser import ingest_edf
        result = ingest_edf(saved_path, patient_id, data_dir=DATA_DIR)
    except ImportError:
        return jsonify({
            "success":    True,
            "async":      True,
            "saved_path": saved_path,
            "message":    "Saved. Watcher will ingest automatically.",
            "patient_id": patient_id,
        })
    except Exception as e:
        log.error(f"Ingest failed: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

    if not result.get("success"):
        return jsonify(result), 400

    # ── AUTO-REGISTER in DB ───────────────────────────────────────────────────
    # Works for ANY patient ID. INSERT OR IGNORE means existing
    # patients are never overwritten. Fully automatic — no manual steps.
    try:
        n_leads = result.get("n_channels", 0)
        rel     = os.path.relpath(result["h5_path"], DATA_DIR)

        auto_register_patient(
            patient_id  = patient_id,
            name        = result.get("patient_name", patient_id),
            h5_rel_path = rel,
            n_leads     = n_leads,
        )
        _invalidate_h5(result["h5_path"])
        log.info(f"[DB] {patient_id} auto-registered  leads={n_leads}  h5={rel}")

    except Exception as e:
        log.warning(f"DB auto-register failed: {e}")
        result["db_warning"] = str(e)

    return jsonify(result), 200


# ══════════════════════════════════════════════════════════════════════════════
# BOOT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    initialize_database()

    # Scan disk and register every patient found — runs on every restart
    all_h5 = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
    if all_h5:
        log.info(f"Boot scan: {len(all_h5)} H5 files found, registering all...")
        upsert_patient_files(DATA_DIR, all_h5)
    else:
        log.warning("No H5 files found — ingest an EDF first")

    run_watcher()
    start_bt_watcher()

    log.info(f"Holter ECG API  →  http://localhost:{PORT}")
    log.info(f"LAN IP: {_get_lan_ip()}:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
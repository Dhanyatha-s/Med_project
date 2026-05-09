"""
api.py  —  Holter ECG REST API  (v7 compatible — dynamic lead detection)
"""

import os, glob, logging
from functools import lru_cache

import h5py
import numpy as np
from flask import Flask, jsonify, request, abort
from flask_cors import CORS

from database import initialize_database, fetch_all_patients, fetch_patient, \
                     upsert_patient_files

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

# ── Auto-detect data directory ────────────────────────────────────────────────
def _find_data_dir():
    candidates = [
        os.environ.get("ECG_DATA_DIR", ""),
        os.path.join(os.path.dirname(__file__), "..", "data"),  # project root/data
        os.path.join(os.path.dirname(__file__), "data"),         # backend/data
        os.path.dirname(__file__),
    ]
    for c in candidates:
        c = os.path.normpath(c)
        if c and os.path.isdir(c) and glob.glob(os.path.join(c, "*.h5")):
            log.info(f"DATA_DIR → {c}  ({len(glob.glob(os.path.join(c,'*.h5')))} .h5 files)")
            return c
    fallback = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))
    log.warning(f"No .h5 files found — watching: {fallback}")
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

# ── H5 handle cache ───────────────────────────────────────────────────────────
_h5_cache = {}

def _open_h5(path):
    path = os.path.normpath(path)
    if path not in _h5_cache:
        if not os.path.exists(path):
            log.warning(f"H5 not found: {path}")
            return None
        try:
            _h5_cache[path] = h5py.File(path, "r")
            log.info(f"Opened: {path}  shape={_h5_cache[path]['ecg'].shape}")
        except Exception as e:
            log.error(f"Cannot open {path}: {e}")
            return None
    return _h5_cache[path]

def _get_lead_names(fh):
    """Read lead names from H5 metadata, or infer from column count."""
    import json
    try:
        raw = fh.attrs.get("lead_names")
        if raw is None:
            try: raw = fh["metadata"].attrs.get("lead_names")
            except: pass
        if raw:
            names = json.loads(raw) if isinstance(raw, str) else list(raw)
            if isinstance(names, list) and len(names) == fh["ecg"].shape[1]:
                return [str(n) for n in names]
    except Exception:
        pass
    n = int(fh["ecg"].shape[1])
    return STANDARD_LEAD_NAMES.get(n, [f"Ch{i+1}" for i in range(n)])

def _best_h5_for_patient(patient_id):
    """
    Return (fh, lead_names, patient_dict).
    Tries DB entry first, then scans DATA_DIR for best match.
    """
    patient = fetch_patient(patient_id)

    if patient:
        # Try 12-lead first, then 3-lead
        for key in ("h5_12lead", "h5_3lead"):
            fname = patient.get(key, "")
            if fname:
                fh = _open_h5(os.path.join(DATA_DIR, fname))
                if fh is not None:
                    return fh, _get_lead_names(fh), patient

    # Fallback: scan DATA_DIR and pick file with most leads
    best_fh, best_names = None, []
    for fname in sorted(os.listdir(DATA_DIR)):
        if not fname.endswith(".h5"):
            continue
        fh = _open_h5(os.path.join(DATA_DIR, fname))
        if fh is None:
            continue
        names = _get_lead_names(fh)
        if len(names) > len(best_names):
            best_fh, best_names = fh, names

    if best_fh:
        log.info(f"Auto-selected {len(best_names)}-lead file for {patient_id}")
    return best_fh, best_names, patient or {"id": patient_id, "name": patient_id}

# ── Flask app ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

@app.get("/health")
def health():
    h5_files = glob.glob(os.path.join(DATA_DIR, "*.h5"))
    return jsonify({
        "status":   "ok",
        "data_dir": DATA_DIR,
        "h5_files": [os.path.basename(f) for f in h5_files],
    })

@app.get("/api/files")
def list_files():
    """Scan DATA_DIR and return every .h5 file with metadata."""
    results = []
    for fname in sorted(os.listdir(DATA_DIR)):
        if not fname.endswith(".h5"):
            continue
        fpath = os.path.join(DATA_DIR, fname)
        fh    = _open_h5(fpath)
        if fh is None:
            continue
        names  = _get_lead_names(fh)
        shape  = fh["ecg"].shape
        sr     = int(fh.attrs.get("sampling_rate", 250))
        dur_hr = shape[0] / sr / 3600
        results.append({
            "filename":    fname,
            "n_leads":     len(names),
            "lead_names":  names,
            "sr":          sr,
            "total_samples": int(shape[0]),
            "duration_hr": round(dur_hr, 3),
            "size_mb":     round(os.path.getsize(fpath) / 1024 / 1024, 1),
        })
    return jsonify(results)

@app.get("/api/patients")
def list_patients():
    return jsonify(fetch_all_patients())

@app.get("/api/patients/<patient_id>")
def get_patient(patient_id):
    p = fetch_patient(patient_id)
    if not p:
        abort(404, f"Patient {patient_id} not found")
    return jsonify(p)

# ── DYNAMIC ECG ENDPOINT (v7 frontend calls this) ─────────────────────────────
@app.get("/api/ecg/<patient_id>")
def get_ecg_dynamic(patient_id):
    """
    Main endpoint — auto-detects leads from H5 file.
    Called by v7 useEcgData hook: /api/ecg/P001?start=0&duration=30
    Returns lead_names so the frontend can drive layout dynamically.
    """
    start    = float(request.args.get("start", 0))
    duration = min(float(request.args.get("duration", 10)), 30.0)

    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        available = [f for f in os.listdir(DATA_DIR) if f.endswith(".h5")]
        return jsonify({
            "error":     f"No H5 file found for {patient_id}",
            "data_dir":  DATA_DIR,
            "available": available,
        }), 404

    sr    = int(fh.attrs.get("sampling_rate", 250))
    total = int(fh["ecg"].shape[0])
    s     = max(0, int(start * sr))
    e     = min(s + int(duration * sr), total)

    if s >= total:
        return jsonify({"error": f"start={start}s beyond recording"}), 400

    block     = fh["ecg"][s:e, :]
    leads_out = {}
    for i, name in enumerate(lead_names):
        if i < block.shape[1]:
            leads_out[name] = block[:, i].tolist()

    log.info(f"ECG {patient_id} leads={lead_names} t=[{start:.1f},{start+duration:.1f}]s")
    return jsonify({
        "patient_id": patient_id,
        "lead_names": lead_names,       # frontend reads this to drive layout
        "n_leads":    len(lead_names),
        "sr":         sr,
        "start":      start,
        "duration":   duration,
        "total_sec":  total / sr,
        "leads":      leads_out,
    })

# ── LEGACY ENDPOINTS (keep for backward compat) ───────────────────────────────
@app.get("/api/ecg/<patient_id>/<int:n_leads>/all")
def get_all_leads_legacy(patient_id, n_leads):
    start    = float(request.args.get("start", 0))
    duration = min(float(request.args.get("duration", 10)), 30.0)
    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        abort(404)
    sr    = int(fh.attrs.get("sampling_rate", 250))
    total = int(fh["ecg"].shape[0])
    s     = max(0, int(start * sr))
    e     = min(s + int(duration * sr), total)
    block = fh["ecg"][s:e, :]
    leads_out = {name: block[:, i].tolist()
                 for i, name in enumerate(lead_names) if i < block.shape[1]}
    return jsonify({
        "n_leads": len(lead_names), "lead_names": lead_names,
        "sr": sr, "start": start, "duration": duration,
        "total_sec": total / sr, "leads": leads_out,
    })

@app.get("/api/ecg/<patient_id>/<int:n_leads>")
def get_single_lead_legacy(patient_id, n_leads):
    lead     = request.args.get("lead", "II")
    start    = float(request.args.get("start", 0))
    duration = min(float(request.args.get("duration", 10)), 60.0)
    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        abort(404)
    if lead not in lead_names:
        abort(400, f"Lead '{lead}' not in file. Available: {lead_names}")
    col   = lead_names.index(lead)
    sr    = int(fh.attrs.get("sampling_rate", 250))
    total = int(fh["ecg"].shape[0])
    s, e  = int(start * sr), min(int(start * sr) + int(duration * sr), total)
    return jsonify({"lead": lead, "sr": sr, "start": start,
                    "samples": fh["ecg"][s:e, col].tolist()})

# ── PATCH /api/patients/<id>  (add PATCH method for inline edit) ──────────────

@app.route("/api/patients/<patient_id>", methods=["GET", "PATCH"])
def patient_detail(patient_id):
    """
    GET  → return patient record (existing behaviour)
    PATCH→ update name/age/sex/dob/created_at from request JSON
    """
    if request.method == "GET":
        p = fetch_patient(patient_id)
        if not p:
            abort(404, f"Patient {patient_id} not found")
        return jsonify(p)

    # PATCH
    data    = request.json or {}
    allowed = {"name", "age", "sex", "dob", "created_at"}
    updates = {k: v for k, v in data.items() if k in allowed}

    if not updates:
        return jsonify({"error": "No valid fields to update"}), 400

    try:
        from database import get_conn
        with get_conn() as conn:
            sets  = ", ".join(f"{k}=?" for k in updates)
            vals  = list(updates.values()) + [patient_id]
            conn.execute(f"UPDATE patients SET {sets} WHERE id=?", vals)
            conn.commit()
        updated = fetch_patient(patient_id)
        log.info(f"Patient {patient_id} updated: {updates}")
        return jsonify(updated)
    except Exception as e:
        log.error(f"PATCH /api/patients/{patient_id}: {e}")
        return jsonify({"error": str(e)}), 500


# ── POST /api/import  (EDF file upload → parser.py → H5) ─────────────────────

@app.post("/api/import")
def import_edf():
    """
    Accept an EDF file upload and ingest it for a patient.
    multipart/form-data:
        file        : the .edf file
        patient_id  : e.g. "P001"
    """
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No file in request"}), 400

    patient_id = request.form.get("patient_id", "UNKNOWN")
    file       = request.files["file"]

    if not file.filename.lower().endswith((".edf", ".edf+")):
        return jsonify({"success": False, "error": "File must be .edf or .edf+"}), 400

    # Save uploaded file to incoming/ folder
    incoming_dir = os.path.join(DATA_DIR, "incoming")
    os.makedirs(incoming_dir, exist_ok=True)
    safe_name  = f"{patient_id}_{file.filename}"
    saved_path = os.path.join(incoming_dir, safe_name)
    file.save(saved_path)
    log.info(f"EDF uploaded: {saved_path} for patient {patient_id}")

    try:
        from parser import ingest_edf
        result = ingest_edf(saved_path, patient_id, data_dir=DATA_DIR)
    except ImportError:
        return jsonify({
            "success": False,
            "error": "parser.py not found — copy it to backend/ first"
        }), 500
    except Exception as e:
        log.error(f"Ingest failed: {e}")
        return jsonify({"success": False, "error": str(e)}), 500

    if not result["success"]:
        return jsonify(result), 400

    # Update DB with new H5 file path
    try:
        from database import get_conn
        n_leads = result.get("n_channels", 0)
        col     = "h5_12lead" if n_leads == 12 else "h5_3lead"
        # Store relative path from DATA_DIR
        rel_path = os.path.relpath(result["h5_path"], DATA_DIR)
        with get_conn() as conn:
            conn.execute(
                f"UPDATE patients SET {col}=? WHERE id=?",
                (rel_path, patient_id)
            )
            conn.commit()
        log.info(f"DB updated: {patient_id}.{col} = {rel_path}")
    except Exception as e:
        log.warning(f"DB update after import failed: {e}")
        result["db_warning"] = str(e)

    # Invalidate H5 cache so next request opens the new file
    _h5_cache.pop(os.path.normpath(result["h5_path"]), None)

    return jsonify(result), 200


# ── Boot ──────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    initialize_database()

    h5_files = glob.glob(os.path.join(DATA_DIR, "*.h5"))
    if h5_files:
        log.info(f"Auto-registering {len(h5_files)} .h5 files...")
        upsert_patient_files(DATA_DIR, h5_files)
    else:
        log.warning("No .h5 files found in data/ — run storage.py first")

    log.info(f"ECG API → http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)

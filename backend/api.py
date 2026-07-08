# """
# api.py  —  Holter ECG REST API  (v8 — full acquisition integration)
# ─────────────────────────────────────────────────────────────────────────────
# Endpoint map (all routes):

#   System
#     GET  /health                          — liveness + H5 inventory
#     GET  /api/network/ip                  — LAN IP for Holter device config

#   Data acquisition
#     POST /upload                          — WiFi streaming EDF upload
#     GET  /upload/status                   — list active WiFi sessions
#     GET  /api/transfer/status/<session_id>— poll any session (wifi/usb/sd)
#     GET  /api/transfer/recent             — last 20 sessions
#     GET  /api/transfer/active             — all non-complete sessions

#     GET  /api/usb/ports                   — list serial ports (★ = likely Holter)
#     GET  /api/usb/status                  — USB listener state
#     POST /api/usb/connect                 — start USB listener {port?, patient_id?, baud?}
#     POST /api/usb/disconnect              — stop USB listener

#     GET  /api/bt/status                   — BT receiver state
#     GET  /api/bt/devices                  — paired BT devices (Linux/Windows)
#     POST /api/bt/start                    — start BT watcher {receive_folder?, patient_id?}
#     POST /api/bt/stop                     — stop BT watcher

#   ECG data
#     GET  /api/ecg/<patient_id>            — main ECG endpoint (dynamic leads)
#                                             ?start=<sec>&duration=<sec>
#     GET  /api/ecg/<patient_id>/<n>/all    — legacy all-leads (backward compat)
#     GET  /api/ecg/<patient_id>/<n>        — legacy single-lead (backward compat)
#     GET  /api/files                       — list all H5 files with metadata

#   Patients
#     GET  /api/patients                    — list all patients
#     GET  /api/patients/<id>               — single patient record
#     PATCH/api/patients/<id>               — update name/age/sex/dob
#     POST /api/import                      — multipart EDF upload → ingest

# api.py  —  Holter ECG REST API  (v9 — auto patient registration)
# ─────────────────────────────────────────────────────────────────────────────
# Changes from v8:
#   - /api/import now auto-registers ANY new patient (INSERT OR IGNORE + UPDATE)
#   - Boot scan registers ALL patients found on disk automatically
#   - Fixed double-prefix bug: P003_P003_holter.edf → P003_holter.edf
#   - No manual sqlite commands ever needed again
# """

# """
# api.py  —  Holter ECG REST API  (v10 — Phase 1 complete)
# ─────────────────────────────────────────────────────────────────────────────
# Endpoint map (all routes):

#   System
#     GET  /health                               — liveness + H5 inventory
#     GET  /api/network/ip                       — LAN IP for Holter device config
#     GET  /api/system/priority                  — OS priority status (NEW)
#     POST /api/system/priority/high             — raise priority manually (NEW)
#     POST /api/system/priority/reset            — reset priority (NEW)

#   Data acquisition
#     POST /upload                               — WiFi streaming EDF upload
#     GET  /upload/status                        — list active WiFi sessions
#     GET  /api/transfer/status/<session_id>     — poll any session
#     GET  /api/transfer/recent                  — last 20 sessions
#     GET  /api/transfer/active                  — all non-complete sessions

#     GET  /api/usb/ports                        — list serial ports
#     GET  /api/usb/status                       — USB listener state
#     POST /api/usb/connect                      — start USB listener
#     POST /api/usb/disconnect                   — stop USB listener

#     GET  /api/bt/status                        — BT receiver state
#     GET  /api/bt/devices                       — paired BT devices
#     POST /api/bt/start                         — start BT watcher
#     POST /api/bt/stop                          — stop BT watcher

#   ECG data
#     GET  /api/ecg/<patient_id>                 — main ECG endpoint
#     GET  /api/ecg/<patient_id>/<n>/all         — legacy all-leads
#     GET  /api/ecg/<patient_id>/<n>             — legacy single-lead
#     GET  /api/files                            — list all H5 files

#   Patients
#     GET  /api/patients                         — list all patients
#     GET  /api/patients/<id>                    — single patient record
#     PATCH/api/patients/<id>                    — update name/age/sex/dob
#     POST /api/import                           — multipart EDF upload → ingest

#   Annotations / Patient Diary (NEW)
#     GET  /api/annotations/<patient_id>         — list annotations
#     POST /api/annotations/<patient_id>         — create annotation
#     PATCH/api/annotations/<patient_id>/<id>    — update annotation
#     DELETE/api/annotations/<patient_id>/<id>   — delete annotation
#     POST /api/annotations/<patient_id>/import-device-events

#   Storage management (NEW)
#     GET  /api/storage/stats                    — disk usage + per-patient sizes
#     DELETE /api/storage/patients/<id>/data     — delete H5 files (PDFs kept)

#   PDF Reports (NEW)
#     GET  /api/reports/<patient_id>             — generate + stream PDF
#     POST /api/reports/<patient_id>             — generate with profile + metrics
# """
# import h5py
# import os
# import io
# import glob
# import json
# import socket
# import shutil
# import logging
# import datetime


# import numpy as np
# from flask import Flask, jsonify, request, abort, send_file
# from flask_cors import CORS

# # ── Database imports (Phase 1 complete — includes annotations) ────────────────
# from database import (
#     initialize_database,
#     fetch_all_patients,
#     fetch_patient,
#     upsert_patient_files,
#     auto_register_patient,
#     fetch_annotations,
#     create_annotation,
#     update_annotation,
#     delete_annotation,
#     import_device_events,
#     get_conn,
# )

# # ── New Phase 1 modules ───────────────────────────────────────────────────────
# from report_generator import generate_report
# from priority_manager import set_high_priority, reset_priority, get_priority_info

# # ── Acquisition modules ───────────────────────────────────────────────────────
# from acquisition.watcher        import run_watcher
# from acquisition.wifi_receiver  import wifi_bp
# from acquisition.progress_store import get as ps_get, list_active, list_recent
# from acquisition.usb_serial     import (
#     make_usb_blueprint, start_usb_listener,
#     stop_usb_listener, get_usb_status, list_ports,
# )
# from acquisition.bt_receiver    import (
#     make_bt_blueprint, start_bt_watcher,
#     stop_bt_watcher, get_bt_status,
# )

# logging.basicConfig(
#     level  = logging.INFO,
#     format = "%(asctime)s %(levelname)s %(message)s",
# )
# log = logging.getLogger(__name__)


# # ── Data directory resolution ─────────────────────────────────────────────────

# def _find_data_dir() -> str:
#     candidates = [
#         os.environ.get("ECG_DATA_DIR", ""),
#         os.path.join(os.path.dirname(__file__), "..", "data"),
#         os.path.join(os.path.dirname(__file__), "data"),
#         os.path.dirname(__file__),
#     ]
#     for c in candidates:
#         c = os.path.normpath(c)
#         if c and os.path.isdir(c):
#             h5s = glob.glob(os.path.join(c, "**", "*.h5"), recursive=True)
#             if h5s:
#                 log.info(f"DATA_DIR → {c}  ({len(h5s)} .h5 files)")
#                 return c
#     fallback = os.path.normpath(
#         os.path.join(os.path.dirname(__file__), "..", "data")
#     )
#     log.warning(f"No .h5 files found — data dir: {fallback}")
#     return fallback


# DATA_DIR = _find_data_dir()
# PORT     = int(os.environ.get("PORT", 5000))


# # ── Standard lead names by column count ──────────────────────────────────────

# STANDARD_LEAD_NAMES = {
#     1:  ["II"],
#     2:  ["I", "II"],
#     3:  ["I", "II", "V2"],
#     4:  ["I", "II", "III", "V2"],
#     5:  ["I", "II", "III", "aVR", "V2"],
#     6:  ["I", "II", "III", "aVR", "aVL", "aVF"],
#     7:  ["I", "II", "III", "aVR", "aVL", "aVF", "V1"],
#     8:  ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2"],
#     9:  ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3"],
#     10: ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4"],
#     11: ["I", "II", "III", "aVR", "aVL", "aVF", "V1", "V2", "V3", "V4", "V5"],
#     12: ["I", "II", "III", "aVR", "aVL", "aVF",
#          "V1", "V2", "V3", "V4", "V5", "V6"],
# }


# # ── H5 file handle cache ──────────────────────────────────────────────────────

# _h5_cache: dict = {}


# def _open_h5(path: str):
#     path = os.path.normpath(path)
#     if path not in _h5_cache:
#         if not os.path.exists(path):
#             log.warning(f"H5 not found: {path}")
#             return None
#         try:
#             _h5_cache[path] = h5py.File(path, "r")
#             log.info(f"Opened H5: {path}  shape={_h5_cache[path]['ecg'].shape}")
#         except Exception as e:
#             log.error(f"Cannot open {path}: {e}")
#             return None
#     return _h5_cache[path]


# def _invalidate_h5(path: str):
#     path = os.path.normpath(path)
#     fh   = _h5_cache.pop(path, None)
#     if fh:
#         try:
#             fh.close()
#         except Exception:
#             pass


# def _get_lead_names(fh) -> list[str]:
#     try:
#         raw = fh.attrs.get("lead_names")
#         if raw is None:
#             try:
#                 raw = fh["metadata"].attrs.get("lead_names")
#             except Exception:
#                 pass
#         if raw:
#             names = json.loads(raw) if isinstance(raw, str) else list(raw)
#             if isinstance(names, list) and len(names) == fh["ecg"].shape[1]:
#                 return [str(n) for n in names]
#     except Exception:
#         pass
#     n = int(fh["ecg"].shape[1])
#     return STANDARD_LEAD_NAMES.get(n, [f"Ch{i+1}" for i in range(n)])


# def _best_h5_for_patient(patient_id: str):
#     patient = fetch_patient(patient_id)

#     if patient:
#         for key in ("h5_12lead", "h5_3lead"):
#             fname = patient.get(key, "")
#             if fname:
#                 # fname may be absolute (new) or relative (legacy)
#                 for candidate in [
#                     fname,
#                     os.path.join(DATA_DIR, fname),
#                     os.path.join(DATA_DIR, "patients", patient_id, "ecg.h5"),
#                 ]:
#                     fh = _open_h5(candidate)
#                     if fh is not None:
#                         return fh, _get_lead_names(fh), patient

#     pat_dir = os.path.join(DATA_DIR, "patients", patient_id)
#     if os.path.isdir(pat_dir):
#         for fname in sorted(os.listdir(pat_dir), reverse=True):
#             if fname.endswith(".h5"):
#                 fh = _open_h5(os.path.join(pat_dir, fname))
#                 if fh is not None:
#                     return fh, _get_lead_names(fh), \
#                            patient or {"id": patient_id, "name": patient_id}

#     best_fh, best_names = None, []
#     for root, _, files in os.walk(DATA_DIR):
#         for fname in sorted(files):
#             if not fname.endswith(".h5"):
#                 continue
#             fh = _open_h5(os.path.join(root, fname))
#             if fh is None:
#                 continue
#             names = _get_lead_names(fh)
#             if len(names) > len(best_names):
#                 best_fh, best_names = fh, names

#     return best_fh, best_names, patient or {"id": patient_id, "name": patient_id}


# def _get_lan_ip() -> str:
#     try:
#         s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
#         s.connect(("8.8.8.8", 80))
#         ip = s.getsockname()[0]
#         s.close()
#         return ip
#     except Exception:
#         return "127.0.0.1"


# # ── Flask app ─────────────────────────────────────────────────────────────────

# app = Flask(__name__)
# CORS(app, resources={r"/*": {"origins": "*"}})

# app.register_blueprint(wifi_bp)
# app.register_blueprint(make_usb_blueprint())
# app.register_blueprint(make_bt_blueprint())


# # ══════════════════════════════════════════════════════════════════════════════
# # SYSTEM
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/health")
# def health():
#     h5_files = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
#     return jsonify({
#         "status":   "ok",
#         "version":  "v10",
#         "data_dir": DATA_DIR,
#         "lan_ip":   _get_lan_ip(),
#         "port":     PORT,
#         "h5_count": len(h5_files),
#         "h5_files": [os.path.relpath(f, DATA_DIR) for f in h5_files],
#     })


# @app.get("/api/network/ip")
# def network_ip():
#     return jsonify({"ip": _get_lan_ip()})


# # ══════════════════════════════════════════════════════════════════════════════
# # TRANSFER STATUS
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/api/transfer/status/<session_id>")
# def transfer_status(session_id):
#     s = ps_get(session_id)
#     if not s:
#         abort(404, f"Session {session_id} not found")
#     return jsonify(s)


# @app.get("/api/transfer/active")
# def transfer_active():
#     return jsonify(list_active())


# @app.get("/api/transfer/recent")
# def transfer_recent():
#     limit = min(int(request.args.get("limit", 20)), 100)
#     return jsonify(list_recent(limit))


# # ══════════════════════════════════════════════════════════════════════════════
# # USB / BT STATUS
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/api/usb/ports")
# def usb_ports():
#     return jsonify(list_ports())


# @app.get("/api/usb/status")
# def usb_status():
#     return jsonify(get_usb_status())


# @app.get("/api/bt/status")
# def bt_status():
#     return jsonify(get_bt_status())


# # ══════════════════════════════════════════════════════════════════════════════
# # ECG DATA
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/api/ecg/<patient_id>")
# def get_ecg_dynamic(patient_id):
#     start    = float(request.args.get("start",    0))
#     duration = min(float(request.args.get("duration", 10)), 30.0)

#     fh, lead_names, _ = _best_h5_for_patient(patient_id)
#     if fh is None:
#         available = glob.glob(
#             os.path.join(DATA_DIR, "**", "*.h5"), recursive=True
#         )
#         return jsonify({
#             "error":     f"No H5 file found for patient {patient_id}",
#             "data_dir":  DATA_DIR,
#             "available": [os.path.relpath(f, DATA_DIR) for f in available],
#         }), 404

#     sr    = int(fh.attrs.get("sampling_rate", 250))
#     total = int(fh["ecg"].shape[0])
#     s     = max(0, int(start * sr))
#     e     = min(s + int(duration * sr), total)

#     if s >= total:
#         return jsonify({"error": f"start={start}s beyond recording end"}), 400

#     block     = fh["ecg"][s:e, :]
#     leads_out = {
#         name: block[:, i].tolist()
#         for i, name in enumerate(lead_names)
#         if i < block.shape[1]
#     }

#     log.info(f"ECG {patient_id} leads={lead_names} "
#              f"t=[{start:.1f},{start+duration:.1f}]s")
#     return jsonify({
#         "patient_id": patient_id,
#         "lead_names": lead_names,
#         "n_leads":    len(lead_names),
#         "sr":         sr,
#         "start":      start,
#         "duration":   duration,
#         "total_sec":  round(total / sr, 2),
#         "leads":      leads_out,
#     })


# @app.get("/api/ecg/<patient_id>/<int:n_leads>/all")
# def get_all_leads_legacy(patient_id, n_leads):
#     start    = float(request.args.get("start",    0))
#     duration = min(float(request.args.get("duration", 10)), 30.0)
#     fh, lead_names, _ = _best_h5_for_patient(patient_id)
#     if fh is None:
#         abort(404)
#     sr    = int(fh.attrs.get("sampling_rate", 250))
#     total = int(fh["ecg"].shape[0])
#     s     = max(0, int(start * sr))
#     e     = min(s + int(duration * sr), total)
#     block = fh["ecg"][s:e, :]
#     leads_out = {
#         name: block[:, i].tolist()
#         for i, name in enumerate(lead_names)
#         if i < block.shape[1]
#     }
#     return jsonify({
#         "n_leads": len(lead_names), "lead_names": lead_names,
#         "sr": sr, "start": start, "duration": duration,
#         "total_sec": round(total / sr, 2), "leads": leads_out,
#     })


# @app.get("/api/ecg/<patient_id>/<int:n_leads>")
# def get_single_lead_legacy(patient_id, n_leads):
#     lead     = request.args.get("lead", "II")
#     start    = float(request.args.get("start",    0))
#     duration = min(float(request.args.get("duration", 10)), 60.0)
#     fh, lead_names, _ = _best_h5_for_patient(patient_id)
#     if fh is None:
#         abort(404)
#     if lead not in lead_names:
#         abort(400, f"Lead '{lead}' not in file. Available: {lead_names}")
#     col   = lead_names.index(lead)
#     sr    = int(fh.attrs.get("sampling_rate", 250))
#     total = int(fh["ecg"].shape[0])
#     s     = max(0, int(start * sr))
#     e     = min(s + int(duration * sr), total)
#     return jsonify({
#         "lead": lead, "sr": sr, "start": start,
#         "total_sec": round(total / sr, 2),
#         "samples": fh["ecg"][s:e, col].tolist(),
#     })


# @app.get("/api/files")
# def list_files():
#     results = []
#     for fpath in sorted(
#         glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
#     ):
#         fh = _open_h5(fpath)
#         if fh is None:
#             continue
#         names = _get_lead_names(fh)
#         shape = fh["ecg"].shape
#         sr    = int(fh.attrs.get("sampling_rate", 250))
#         results.append({
#             "filename":      os.path.relpath(fpath, DATA_DIR),
#             "n_leads":       len(names),
#             "lead_names":    names,
#             "sr":            sr,
#             "total_samples": int(shape[0]),
#             "duration_hr":   round(shape[0] / sr / 3600, 3),
#             "duration_sec":  round(shape[0] / sr, 1),
#             "size_mb":       round(os.path.getsize(fpath) / 1024 / 1024, 1),
#             "status":        str(fh.attrs.get("status", "unknown")),
#         })
#     return jsonify(results)


# # ══════════════════════════════════════════════════════════════════════════════
# # PATIENTS
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/api/patients")
# def list_patients():
#     return jsonify(fetch_all_patients())


# @app.route("/api/patients/<patient_id>", methods=["GET", "PATCH", "DELETE"])
# def patient_detail(patient_id):
#     if request.method == "GET":
#         p = fetch_patient(patient_id)
#         if not p:
#             abort(404, f"Patient {patient_id} not found")
#         return jsonify(p)

#     if request.method == "DELETE":
#         p = fetch_patient(patient_id)
#         if not p:
#             return jsonify({"error": f"Patient {patient_id} not found"}), 404
#         try:
#             with get_conn() as conn:
#                 conn.execute("DELETE FROM patients WHERE id=?", (patient_id,))
#                 conn.commit()
#             log.info(f"[DB] Patient {patient_id} deleted")
#             return jsonify({"deleted": patient_id})
#         except Exception as e:
#             log.error(f"Delete patient {patient_id} failed: {e}")
#             return jsonify({"error": str(e)}), 500

#     data    = request.get_json(force=True, silent=True) or {}
#     allowed = {"name", "age", "sex", "dob", "created_at"}
#     updates = {k: v for k, v in data.items() if k in allowed}
#     if not updates:
#         return jsonify(
#             {"error": "Allowed fields: name, age, sex, dob, created_at"}
#         ), 400

#     try:
#         with get_conn() as conn:
#             sets = ", ".join(f"{k}=?" for k in updates)
#             vals = list(updates.values()) + [patient_id]
#             conn.execute(f"UPDATE patients SET {sets} WHERE id=?", vals)
#             conn.commit()
#         updated = fetch_patient(patient_id)
#         if not updated:
#             abort(404)
#         return jsonify(updated)
#     except Exception as e:
#         return jsonify({"error": str(e)}), 500


# @app.post("/api/import")
# def import_edf():
#     if "file" not in request.files:
#         return jsonify({"success": False, "error": "No 'file' field"}), 400

#     patient_id = request.form.get("patient_id", "UNKNOWN").strip()
#     file       = request.files["file"]

#     if not file.filename.lower().endswith((".edf", ".edf+")):
#         return jsonify({"success": False, "error": "File must be .edf"}), 400

#     incoming_dir = os.path.join(DATA_DIR, "incoming")
#     os.makedirs(incoming_dir, exist_ok=True)
#     fname      = file.filename
#     safe_name  = fname if fname.upper().startswith(patient_id.upper()) \
#                        else f"{patient_id}_{fname}"
#     saved_path = os.path.join(incoming_dir, safe_name)
#     file.save(saved_path)
#     log.info(f"EDF saved: {saved_path}  patient={patient_id}")

#     try:
#         from parser import ingest_edf
#         # Raise priority during ingest
#         set_high_priority()
#         result = ingest_edf(saved_path, patient_id, data_dir=DATA_DIR)
#     except ImportError:
#         return jsonify({
#             "success":    True,
#             "async":      True,
#             "saved_path": saved_path,
#             "message":    "Saved. Watcher will ingest automatically.",
#             "patient_id": patient_id,
#         })
#     except Exception as e:
#         log.error(f"Ingest failed: {e}")
#         return jsonify({"success": False, "error": str(e)}), 500
#     finally:
#         reset_priority()

#     if not result.get("success"):
#         return jsonify(result), 400

#     try:
#         n_leads  = result.get("n_channels", 0)
#         abs_path = os.path.abspath(result["h5_path"])   # always store absolute

#         auto_register_patient(
#             patient_id  = patient_id,
#             name        = result.get("patient_name", patient_id),
#             h5_rel_path = abs_path,
#             n_leads     = n_leads,
#             data_dir    = DATA_DIR,
#             source_method = request.form.get("source", "sd"),
#         )
#         _invalidate_h5(result["h5_path"])
#         log.info(f"[DB] {patient_id} auto-registered  leads={n_leads}")

#     except Exception as e:
#         log.warning(f"DB auto-register failed: {e}")
#         result["db_warning"] = str(e)

#     return jsonify(result), 200


# # ══════════════════════════════════════════════════════════════════════════════
# # ANNOTATIONS / PATIENT DIARY  (NEW — Phase 1)
# # ══════════════════════════════════════════════════════════════════════════════

# @app.route("/api/annotations/<patient_id>", methods=["GET", "POST"])
# def annotations(patient_id):
#     """
#     GET  — list all annotations for a patient, sorted by timestamp
#     POST — create annotation  { note, timestamp_sec?, type?, source? }
#     """
#     if request.method == "GET":
#         return jsonify(fetch_annotations(patient_id))

#     data   = request.get_json(force=True, silent=True) or {}
#     note   = data.get("note", "").strip()
#     if not note:
#         return jsonify({"error": "note is required"}), 400

#     ts     = data.get("timestamp_sec")
#     ann_tp = data.get("type",   "diary")
#     source = data.get("source", "doctor")

#     try:
#         ann = create_annotation(
#             patient_id    = patient_id,
#             note          = note,
#             timestamp_sec = float(ts) if ts is not None else None,
#             ann_type      = ann_tp,
#             source        = source,
#         )
#         return jsonify(ann), 201
#     except Exception as e:
#         return jsonify({"error": str(e)}), 500


# @app.route("/api/annotations/<patient_id>/<int:ann_id>",
#            methods=["PATCH", "DELETE"])
# def annotation_detail(patient_id, ann_id):
#     """PATCH — update note/timestamp. DELETE — remove."""
#     if request.method == "DELETE":
#         ok = delete_annotation(ann_id)
#         return (jsonify({"deleted": ann_id}) if ok
#                 else (jsonify({"error": "Not found"}), 404))

#     data = request.get_json(force=True, silent=True) or {}
#     note = data.get("note")
#     ts   = data.get("timestamp_sec")
#     try:
#         updated = update_annotation(
#             ann_id,
#             note          = note,
#             timestamp_sec = float(ts) if ts is not None else None,
#         )
#         if not updated:
#             return jsonify({"error": "Not found"}), 404
#         return jsonify(updated)
#     except Exception as e:
#         return jsonify({"error": str(e)}), 500


# @app.post("/api/annotations/<patient_id>/import-device-events")
# def import_device(patient_id):
#     """Bulk-import device button-press events from the Holter recorder."""
#     data   = request.get_json(force=True, silent=True) or {}
#     events = data.get("events", [])
#     if not events:
#         return jsonify({"error": "events array required"}), 400
#     try:
#         count = import_device_events(patient_id, events)
#         return jsonify({"imported": count, "patient_id": patient_id})
#     except Exception as e:
#         return jsonify({"error": str(e)}), 500


# # ══════════════════════════════════════════════════════════════════════════════
# # STORAGE MANAGEMENT  (NEW — Phase 1)
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/api/storage/stats")
# def storage_stats():
#     """Disk usage + per-patient H5 sizes. warning_level: ok/warning/critical."""
#     try:
#         usage    = shutil.disk_usage(DATA_DIR)
#         total_gb = usage.total / (1024**3)
#         used_gb  = usage.used  / (1024**3)
#         free_gb  = usage.free  / (1024**3)
#         free_pct = (usage.free / usage.total) * 100
#         level    = ("critical" if free_gb < 2
#                     else "warning" if free_gb < 10
#                     else "ok")
#     except Exception as e:
#         return jsonify({"error": f"Cannot read disk stats: {e}"}), 500

#     patients_raw  = fetch_all_patients()
#     patient_sizes = []
#     total_h5_mb   = 0.0
#     total_h5_count= 0

#     for p in patients_raw:
#         h5_mb  = 0.0
#         pdf_mb = 0.0

#         pat_dir = os.path.join(DATA_DIR, "patients", p["id"])
#         if os.path.isdir(pat_dir):
#             for fname in os.listdir(pat_dir):
#                 fpath = os.path.join(pat_dir, fname)
#                 sz    = os.path.getsize(fpath) / (1024 * 1024)
#                 if fname.endswith(".h5"):
#                     h5_mb += sz; total_h5_count += 1
#                 elif fname.endswith(".pdf"):
#                     pdf_mb += sz

#         for key in ("h5_3lead", "h5_12lead"):
#             fpath = p.get(key, "")
#             if fpath and not os.path.isabs(fpath):
#                 fpath = os.path.join(DATA_DIR, fpath)
#             if fpath and os.path.exists(fpath):
#                 canonical = os.path.normpath(fpath)
#                 already   = os.path.normpath(pat_dir) in canonical
#                 if not already:
#                     h5_mb += os.path.getsize(fpath) / (1024 * 1024)
#                     total_h5_count += 1

#         total_h5_mb += h5_mb
#         patient_sizes.append({
#             "id":            p["id"],
#             "name":          p["name"],
#             "h5_size_mb":    round(h5_mb,  2),
#             "pdf_size_mb":   round(pdf_mb, 2),
#             "total_size_mb": round(h5_mb + pdf_mb, 2),
#             "has_h5":        h5_mb  > 0,
#             "has_pdf":       pdf_mb > 0,
#         })

#     patient_sizes.sort(key=lambda x: x["total_size_mb"], reverse=True)

#     return jsonify({
#         "disk_total_gb":    round(total_gb, 2),
#         "disk_used_gb":     round(used_gb,  2),
#         "disk_free_gb":     round(free_gb,  2),
#         "disk_free_pct":    round(free_pct, 1),
#         "warning_level":    level,
#         "patients":         patient_sizes,
#         "total_h5_count":   total_h5_count,
#         "total_h5_size_mb": round(total_h5_mb, 2),
#     })


# @app.delete("/api/storage/patients/<patient_id>/data")
# def delete_patient_data(patient_id):
#     """Delete H5 ECG files. PDFs and patient DB record always preserved."""
#     data = request.get_json(force=True, silent=True) or {}
#     if not data.get("confirm"):
#         return jsonify({"error": "Send { confirm: true } to proceed"}), 400

#     p = fetch_patient(patient_id)
#     if not p:
#         return jsonify({"error": f"Patient {patient_id} not found"}), 404

#     deleted_files = []
#     errors        = []

#     for key in ("h5_3lead", "h5_12lead"):
#         fpath = p.get(key, "")
#         if not fpath:
#             continue
#         if not os.path.isabs(fpath):
#             fpath = os.path.join(DATA_DIR, fpath)
#         if os.path.exists(fpath) and fpath.endswith(".h5"):
#             try:
#                 _invalidate_h5(fpath)
#                 os.remove(fpath)
#                 deleted_files.append(fpath)
#                 log.info(f"[Storage] Deleted {fpath}")
#             except Exception as e:
#                 errors.append(str(e))

#     pat_dir = os.path.join(DATA_DIR, "patients", patient_id)
#     if os.path.isdir(pat_dir):
#         for fname in os.listdir(pat_dir):
#             if fname.endswith(".h5"):
#                 fpath = os.path.join(pat_dir, fname)
#                 if fpath not in deleted_files:
#                     try:
#                         _invalidate_h5(fpath)
#                         os.remove(fpath)
#                         deleted_files.append(fpath)
#                         log.info(f"[Storage] Deleted {fpath}")
#                     except Exception as e:
#                         errors.append(str(e))

#     try:
#         with get_conn() as conn:
#             conn.execute(
#                 "UPDATE patients SET h5_3lead='', h5_12lead='' WHERE id=?",
#                 (patient_id,)
#             )
#             conn.commit()
#     except Exception as e:
#         errors.append(f"DB update: {e}")

#     try:
#         create_annotation(
#             patient_id = patient_id,
#             note       = (f"ECG data deleted: {len(deleted_files)} file(s). "
#                           f"PDFs preserved."),
#             ann_type   = "auto",
#             source     = "system",
#         )
#     except Exception:
#         pass

#     return jsonify({
#         "deleted":        deleted_files,
#         "errors":         errors,
#         "pdfs_preserved": True,
#         "patient_record": "preserved",
#     })


# # ══════════════════════════════════════════════════════════════════════════════
# # PDF REPORT GENERATOR  (NEW — Phase 1)
# # ══════════════════════════════════════════════════════════════════════════════

# @app.route("/api/reports/<patient_id>", methods=["GET", "POST"])
# def patient_report(patient_id):
#     """
#     GET  — generate PDF with no body (uses defaults)
#     POST — generate PDF with profile + metrics + notes
#            body: { profile: {...}, metrics: {...}, notes: "..." }
#     ?format=download  — force browser download instead of inline view
#     """
#     p = fetch_patient(patient_id)
#     if not p:
#         return jsonify({"error": f"Patient {patient_id} not found"}), 404

#     anns = fetch_annotations(patient_id)

#     fh, _, _ = _best_h5_for_patient(patient_id)
#     h5_path  = os.path.abspath(fh.filename) if fh is not None else None

#     doctor_notes = request.args.get("notes", "")
#     inline       = request.args.get("format", "inline") != "download"
#     profile      = {}
#     metrics      = None

#     if request.method == "POST":
#         body         = request.get_json(force=True, silent=True) or {}
#         profile      = body.get("profile",  {})
#         metrics      = body.get("metrics",  None)
#         doctor_notes = body.get("notes",    doctor_notes)

#     try:
#         set_high_priority()
#         pdf_bytes = generate_report(
#             patient_id   = patient_id,
#             patient      = p,
#             annotations  = anns,
#             h5_path      = h5_path,
#             profile      = profile,
#             data_dir     = DATA_DIR,
#             metrics      = metrics,
#             doctor_notes = doctor_notes,
#         )
#     except Exception as e:
#         log.error(f"[Report] {patient_id}: {e}")
#         return jsonify({"error": f"Report generation failed: {e}"}), 500
#     finally:
#         reset_priority()

#     fname = (f"Holter_ECG_{patient_id}_"
#              f"{datetime.datetime.now().strftime('%Y%m%d_%H%M')}.pdf")

#     return send_file(
#         io.BytesIO(pdf_bytes),
#         mimetype      = "application/pdf",
#         as_attachment = not inline,
#         download_name = fname,
#     )


# # ══════════════════════════════════════════════════════════════════════════════
# # OS PRIORITY  (NEW — Phase 1)
# # ══════════════════════════════════════════════════════════════════════════════

# @app.get("/api/system/priority")
# def system_priority():
#     """Current process priority: level, method, admin status, pid, RAM."""
#     return jsonify(get_priority_info())


# @app.post("/api/system/priority/high")
# def system_set_high():
#     """Manually raise to high priority (auto-done by ingest/report)."""
#     result = set_high_priority()
#     return jsonify(result), (200 if result["success"] else 500)


# @app.post("/api/system/priority/reset")
# def system_reset_priority():
#     """Reset priority to normal."""
#     return jsonify(reset_priority())


# # ══════════════════════════════════════════════════════════════════════════════
# # BOOT
# # ══════════════════════════════════════════════════════════════════════════════

# if __name__ == "__main__":
#     initialize_database()

#     all_h5 = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
#     if all_h5:
#         log.info(f"Boot scan: {len(all_h5)} H5 files found, registering all...")
#         upsert_patient_files(DATA_DIR, all_h5)
#     else:
#         log.warning("No H5 files found — ingest an EDF first")

#     run_watcher()
#     start_bt_watcher()

#     log.info(f"Holter ECG API v10  →  http://localhost:{PORT}")
#     log.info(f"LAN IP: {_get_lan_ip()}:{PORT}")
#     app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)


# =================================================================================
# =================================================================================
# =================================================================================
"""
api.py  —  Holter ECG REST API  (v11 — RFCOMM BT sender + patient demographics)
─────────────────────────────────────────────────────────────────────────────
Endpoint map (all routes):

  System
    GET  /health                               — liveness + H5 inventory
    GET  /api/network/ip                       — LAN IP for Holter device config
    GET  /api/system/priority                  — OS priority status
    POST /api/system/priority/high             — raise priority manually
    POST /api/system/priority/reset            — reset priority

  Data acquisition
    POST /upload                               — WiFi streaming EDF upload
    GET  /upload/status                        — list active WiFi sessions
    GET  /api/transfer/status/<session_id>     — poll any session
    GET  /api/transfer/recent                  — last 20 sessions
    GET  /api/transfer/active                  — all non-complete sessions

    GET  /api/usb/ports                        — list serial ports        (usb blueprint)
    GET  /api/usb/status                       — USB listener state       (usb blueprint)
    POST /api/usb/connect                      — start USB listener       (usb blueprint)
    POST /api/usb/disconnect                   — stop USB listener        (usb blueprint)

    GET  /api/bt/status                        — BT (OBEX) receiver state (bt blueprint)
    GET  /api/bt/devices                       — paired BT devices        (bt blueprint)
    POST /api/bt/start                         — start BT OBEX watcher    (bt blueprint)
    POST /api/bt/stop                          — stop BT OBEX watcher     (bt blueprint)

    GET  /api/patient/<id>/meta                — patient demographics     (patient_meta blueprint)
                                                  (name/age/sex from BT
                                                  sidecar or EDF header)

  ECG data
    GET  /api/ecg/<patient_id>                 — main ECG endpoint
    GET  /api/ecg/<patient_id>/<n>/all         — legacy all-leads
    GET  /api/ecg/<patient_id>/<n>             — legacy single-lead
    GET  /api/files                            — list all H5 files

  Patients
    GET  /api/patients                         — list all patients
    GET  /api/patients/<id>                    — single patient record
    PATCH/api/patients/<id>                    — update name/age/sex/dob
    POST /api/import                           — multipart EDF upload → ingest

  Annotations / Patient Diary
    GET  /api/annotations/<patient_id>         — list annotations
    POST /api/annotations/<patient_id>         — create annotation
    PATCH/api/annotations/<patient_id>/<id>    — update annotation
    DELETE/api/annotations/<patient_id>/<id>   — delete annotation
    POST /api/annotations/<patient_id>/import-device-events

  Storage management
    GET  /api/storage/stats                    — disk usage + per-patient sizes
    DELETE /api/storage/patients/<id>/data     — delete H5 files (PDFs kept)

  PDF Reports
    GET  /api/reports/<patient_id>             — generate + stream PDF
    POST /api/reports/<patient_id>             — generate with profile + metrics

─────────────────────────────────────────────────────────────────────────────
v11 changes from v10:
  - Removed inline /api/bt/status, /api/usb/ports, /api/usb/status routes —
    these were DUPLICATES of routes already provided by make_bt_blueprint()
    and make_usb_blueprint(), which caused a Flask startup crash
    (AssertionError: View function mapping is overwriting an existing
    endpoint function).
  - Added acquisition.bt_receiver_rfcomm (direct RFCOMM socket receiver,
    companion to the standalone bt_sender.py script) — started at boot
    alongside the existing OBEX-based bt_receiver.
  - Added acquisition.patient_meta blueprint — GET /api/patient/<id>/meta
    returns name/age/sex extracted from a BT .meta.json sidecar or
    directly from the EDF header.
  - WiFi, USB, and Bluetooth (both OBEX and RFCOMM) now all funnel into the
    same IngestSession pipeline and the same auto_register_patient() call,
    so all three transports register patients (incl. demographics where
    available) without conflicts.
"""
import h5py
import os
import io
import glob
import json
import socket
import shutil
import logging
import datetime


import numpy as np
from flask import Flask, jsonify, request, abort, send_file
from flask_cors import CORS

# ── Database imports ───────────────────────────────────────────────────────
from database import (
    initialize_database,
    fetch_all_patients,
    fetch_patient,
    upsert_patient_files,
    auto_register_patient,
    fetch_annotations,
    create_annotation,
    update_annotation,
    delete_annotation,
    import_device_events,
    get_conn,
)

# ── Phase 1 modules ───────────────────────────────────────────────────────────
from report_generator import generate_report
from priority_manager import set_high_priority, reset_priority, get_priority_info

# ── Acquisition modules ───────────────────────────────────────────────────────
from acquisition.watcher        import run_watcher
from acquisition.wifi_receiver  import wifi_bp
from acquisition.progress_store import get as ps_get, list_active, list_recent
from acquisition.usb_serial     import (
    make_usb_blueprint, start_usb_listener,
    stop_usb_listener,
)
from acquisition.bt_receiver    import (
    make_bt_blueprint, start_bt_watcher,
    stop_bt_watcher,
)
from acquisition.bt_receiver_rfcomm import (
    start_rfcomm_server, stop_rfcomm_server,
)
from acquisition.patient_meta   import make_patient_meta_blueprint

logging.basicConfig(
    level  = logging.INFO,
    format = "%(asctime)s %(levelname)s %(message)s",
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
    12: ["I", "II", "III", "aVR", "aVL", "aVF",
         "V1", "V2", "V3", "V4", "V5", "V6"],
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
    fh   = _h5_cache.pop(path, None)
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
                # fname may be absolute (new) or relative (legacy)
                for candidate in [
                    fname,
                    os.path.join(DATA_DIR, fname),
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
                    return fh, _get_lead_names(fh), \
                           patient or {"id": patient_id, "name": patient_id}

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
app.register_blueprint(make_patient_meta_blueprint())


# ══════════════════════════════════════════════════════════════════════════════
# SYSTEM
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/health")
def health():
    h5_files = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
    return jsonify({
        "status":   "ok",
        "version":  "v11",
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
# NOTE: /api/usb/ports, /api/usb/status, /api/bt/status, /api/bt/devices,
# /api/bt/start, /api/bt/stop, /api/usb/connect, /api/usb/disconnect are all
# provided by make_usb_blueprint() / make_bt_blueprint() registered above.
# Do NOT redefine them here — Flask raises AssertionError on duplicate
# endpoint names if you do (this was the v10 bug).


# ══════════════════════════════════════════════════════════════════════════════
# ECG DATA
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/ecg/<patient_id>")
def get_ecg_dynamic(patient_id):
    start    = float(request.args.get("start",    0))
    duration = min(float(request.args.get("duration", 10)), 30.0)

    fh, lead_names, _ = _best_h5_for_patient(patient_id)
    if fh is None:
        available = glob.glob(
            os.path.join(DATA_DIR, "**", "*.h5"), recursive=True
        )
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

    log.info(f"ECG {patient_id} leads={lead_names} "
             f"t=[{start:.1f},{start+duration:.1f}]s")
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
    for fpath in sorted(
        glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
    ):
        fh = _open_h5(fpath)
        if fh is None:
            continue
        names = _get_lead_names(fh)
        shape = fh["ecg"].shape
        sr    = int(fh.attrs.get("sampling_rate", 250))
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


@app.route("/api/patients/<patient_id>", methods=["GET", "PATCH", "DELETE"])
def patient_detail(patient_id):
    if request.method == "GET":
        p = fetch_patient(patient_id)
        if not p:
            abort(404, f"Patient {patient_id} not found")
        return jsonify(p)

    if request.method == "DELETE":
        p = fetch_patient(patient_id)
        if not p:
            return jsonify({"error": f"Patient {patient_id} not found"}), 404
        try:
            with get_conn() as conn:
                conn.execute("DELETE FROM patients WHERE id=?", (patient_id,))
                conn.commit()
            log.info(f"[DB] Patient {patient_id} deleted")
            return jsonify({"deleted": patient_id})
        except Exception as e:
            log.error(f"Delete patient {patient_id} failed: {e}")
            return jsonify({"error": str(e)}), 500

    data    = request.get_json(force=True, silent=True) or {}
    allowed = {"name", "age", "sex", "dob", "created_at"}
    updates = {k: v for k, v in data.items() if k in allowed}
    if not updates:
        return jsonify(
            {"error": "Allowed fields: name, age, sex, dob, created_at"}
        ), 400

    try:
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
    if "file" not in request.files:
        return jsonify({"success": False, "error": "No 'file' field"}), 400

    patient_id = request.form.get("patient_id", "UNKNOWN").strip()
    file       = request.files["file"]

    if not file.filename.lower().endswith((".edf", ".edf+")):
        return jsonify({"success": False, "error": "File must be .edf"}), 400

    incoming_dir = os.path.join(DATA_DIR, "incoming")
    os.makedirs(incoming_dir, exist_ok=True)
    fname      = file.filename
    safe_name  = fname if fname.upper().startswith(patient_id.upper()) \
                       else f"{patient_id}_{fname}"
    saved_path = os.path.join(incoming_dir, safe_name)
    file.save(saved_path)
    log.info(f"EDF saved: {saved_path}  patient={patient_id}")

    try:
        from parser import ingest_edf
        # Raise priority during ingest
        set_high_priority()
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
    finally:
        reset_priority()

    if not result.get("success"):
        return jsonify(result), 400

    try:
        n_leads  = result.get("n_channels", 0)
        abs_path = os.path.abspath(result["h5_path"])   # always store absolute

        # Pull demographics straight from the saved EDF (covers the case
        # where /api/import is used directly, bypassing the BT/USB
        # IngestSession path that also calls extract_patient_meta).
        age = sex = None
        try:
            from acquisition.patient_meta import extract_patient_meta
            meta = extract_patient_meta(saved_path)
            age  = meta.get("age")
            sex  = meta.get("sex")
            if not result.get("patient_name") and meta.get("name"):
                result["patient_name"] = meta["name"]
        except Exception as meta_err:
            log.warning(f"[Import] patient_meta extraction failed: {meta_err}")

        auto_register_patient(
            patient_id  = patient_id,
            name        = result.get("patient_name", patient_id),
            h5_rel_path = abs_path,
            n_leads     = n_leads,
            data_dir    = DATA_DIR,
            source_method = request.form.get("source", "sd"),
            age = age,
            sex = sex,
        )
        _invalidate_h5(result["h5_path"])
        log.info(f"[DB] {patient_id} auto-registered  leads={n_leads}")

    except Exception as e:
        log.warning(f"DB auto-register failed: {e}")
        result["db_warning"] = str(e)

    return jsonify(result), 200


# ══════════════════════════════════════════════════════════════════════════════
# ANNOTATIONS / PATIENT DIARY
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/annotations/<patient_id>", methods=["GET", "POST"])
def annotations(patient_id):
    """
    GET  — list all annotations for a patient, sorted by timestamp
    POST — create annotation  { note, timestamp_sec?, type?, source? }
    """
    if request.method == "GET":
        return jsonify(fetch_annotations(patient_id))

    data   = request.get_json(force=True, silent=True) or {}
    note   = data.get("note", "").strip()
    if not note:
        return jsonify({"error": "note is required"}), 400

    ts     = data.get("timestamp_sec")
    ann_tp = data.get("type",   "diary")
    source = data.get("source", "doctor")

    try:
        ann = create_annotation(
            patient_id    = patient_id,
            note          = note,
            timestamp_sec = float(ts) if ts is not None else None,
            ann_type      = ann_tp,
            source        = source,
        )
        return jsonify(ann), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/annotations/<patient_id>/<int:ann_id>",
           methods=["PATCH", "DELETE"])
def annotation_detail(patient_id, ann_id):
    """PATCH — update note/timestamp. DELETE — remove."""
    if request.method == "DELETE":
        ok = delete_annotation(ann_id)
        return (jsonify({"deleted": ann_id}) if ok
                else (jsonify({"error": "Not found"}), 404))

    data = request.get_json(force=True, silent=True) or {}
    note = data.get("note")
    ts   = data.get("timestamp_sec")
    try:
        updated = update_annotation(
            ann_id,
            note          = note,
            timestamp_sec = float(ts) if ts is not None else None,
        )
        if not updated:
            return jsonify({"error": "Not found"}), 404
        return jsonify(updated)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.post("/api/annotations/<patient_id>/import-device-events")
def import_device(patient_id):
    """Bulk-import device button-press events from the Holter recorder."""
    data   = request.get_json(force=True, silent=True) or {}
    events = data.get("events", [])
    if not events:
        return jsonify({"error": "events array required"}), 400
    try:
        count = import_device_events(patient_id, events)
        return jsonify({"imported": count, "patient_id": patient_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ══════════════════════════════════════════════════════════════════════════════
# STORAGE MANAGEMENT
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/storage/stats")
def storage_stats():
    """Disk usage + per-patient H5 sizes. warning_level: ok/warning/critical."""
    try:
        usage    = shutil.disk_usage(DATA_DIR)
        total_gb = usage.total / (1024**3)
        used_gb  = usage.used  / (1024**3)
        free_gb  = usage.free  / (1024**3)
        free_pct = (usage.free / usage.total) * 100
        level    = ("critical" if free_gb < 2
                    else "warning" if free_gb < 10
                    else "ok")
    except Exception as e:
        return jsonify({"error": f"Cannot read disk stats: {e}"}), 500

    patients_raw  = fetch_all_patients()
    patient_sizes = []
    total_h5_mb   = 0.0
    total_h5_count= 0

    for p in patients_raw:
        h5_mb  = 0.0
        pdf_mb = 0.0

        pat_dir = os.path.join(DATA_DIR, "patients", p["id"])
        if os.path.isdir(pat_dir):
            for fname in os.listdir(pat_dir):
                fpath = os.path.join(pat_dir, fname)
                sz    = os.path.getsize(fpath) / (1024 * 1024)
                if fname.endswith(".h5"):
                    h5_mb += sz; total_h5_count += 1
                elif fname.endswith(".pdf"):
                    pdf_mb += sz

        for key in ("h5_3lead", "h5_12lead"):
            fpath = p.get(key, "")
            if fpath and not os.path.isabs(fpath):
                fpath = os.path.join(DATA_DIR, fpath)
            if fpath and os.path.exists(fpath):
                canonical = os.path.normpath(fpath)
                already   = os.path.normpath(pat_dir) in canonical
                if not already:
                    h5_mb += os.path.getsize(fpath) / (1024 * 1024)
                    total_h5_count += 1

        total_h5_mb += h5_mb
        patient_sizes.append({
            "id":            p["id"],
            "name":          p["name"],
            "h5_size_mb":    round(h5_mb,  2),
            "pdf_size_mb":   round(pdf_mb, 2),
            "total_size_mb": round(h5_mb + pdf_mb, 2),
            "has_h5":        h5_mb  > 0,
            "has_pdf":       pdf_mb > 0,
        })

    patient_sizes.sort(key=lambda x: x["total_size_mb"], reverse=True)

    return jsonify({
        "disk_total_gb":    round(total_gb, 2),
        "disk_used_gb":     round(used_gb,  2),
        "disk_free_gb":     round(free_gb,  2),
        "disk_free_pct":    round(free_pct, 1),
        "warning_level":    level,
        "patients":         patient_sizes,
        "total_h5_count":   total_h5_count,
        "total_h5_size_mb": round(total_h5_mb, 2),
    })


@app.delete("/api/storage/patients/<patient_id>/data")
def delete_patient_data(patient_id):
    """Delete H5 ECG files. PDFs and patient DB record always preserved."""
    data = request.get_json(force=True, silent=True) or {}
    if not data.get("confirm"):
        return jsonify({"error": "Send { confirm: true } to proceed"}), 400

    p = fetch_patient(patient_id)
    if not p:
        return jsonify({"error": f"Patient {patient_id} not found"}), 404

    deleted_files = []
    errors        = []

    for key in ("h5_3lead", "h5_12lead"):
        fpath = p.get(key, "")
        if not fpath:
            continue
        if not os.path.isabs(fpath):
            fpath = os.path.join(DATA_DIR, fpath)
        if os.path.exists(fpath) and fpath.endswith(".h5"):
            try:
                _invalidate_h5(fpath)
                os.remove(fpath)
                deleted_files.append(fpath)
                log.info(f"[Storage] Deleted {fpath}")
            except Exception as e:
                errors.append(str(e))

    pat_dir = os.path.join(DATA_DIR, "patients", patient_id)
    if os.path.isdir(pat_dir):
        for fname in os.listdir(pat_dir):
            if fname.endswith(".h5"):
                fpath = os.path.join(pat_dir, fname)
                if fpath not in deleted_files:
                    try:
                        _invalidate_h5(fpath)
                        os.remove(fpath)
                        deleted_files.append(fpath)
                        log.info(f"[Storage] Deleted {fpath}")
                    except Exception as e:
                        errors.append(str(e))

    try:
        with get_conn() as conn:
            conn.execute(
                "UPDATE patients SET h5_3lead='', h5_12lead='' WHERE id=?",
                (patient_id,)
            )
            conn.commit()
    except Exception as e:
        errors.append(f"DB update: {e}")

    try:
        create_annotation(
            patient_id = patient_id,
            note       = (f"ECG data deleted: {len(deleted_files)} file(s). "
                          f"PDFs preserved."),
            ann_type   = "auto",
            source     = "system",
        )
    except Exception:
        pass

    return jsonify({
        "deleted":        deleted_files,
        "errors":         errors,
        "pdfs_preserved": True,
        "patient_record": "preserved",
    })


# ══════════════════════════════════════════════════════════════════════════════
# PDF REPORT GENERATOR
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/api/reports/<patient_id>", methods=["GET", "POST"])
def patient_report(patient_id):
    """
    GET  — generate PDF with no body (uses defaults)
    POST — generate PDF with profile + metrics + notes
           body: { profile: {...}, metrics: {...}, notes: "..." }
    ?format=download  — force browser download instead of inline view
    """
    p = fetch_patient(patient_id)
    if not p:
        return jsonify({"error": f"Patient {patient_id} not found"}), 404

    anns = fetch_annotations(patient_id)

    fh, _, _ = _best_h5_for_patient(patient_id)
    h5_path  = os.path.abspath(fh.filename) if fh is not None else None

    doctor_notes = request.args.get("notes", "")
    inline       = request.args.get("format", "inline") != "download"
    profile      = {}
    metrics      = None

    if request.method == "POST":
        body         = request.get_json(force=True, silent=True) or {}
        profile      = body.get("profile",  {})
        metrics      = body.get("metrics",  None)
        doctor_notes = body.get("notes",    doctor_notes)

    try:
        set_high_priority()
        pdf_bytes = generate_report(
            patient_id   = patient_id,
            patient      = p,
            annotations  = anns,
            h5_path      = h5_path,
            profile      = profile,
            data_dir     = DATA_DIR,
            metrics      = metrics,
            doctor_notes = doctor_notes,
        )
    except Exception as e:
        log.error(f"[Report] {patient_id}: {e}")
        return jsonify({"error": f"Report generation failed: {e}"}), 500
    finally:
        reset_priority()

    fname = (f"Holter_ECG_{patient_id}_"
             f"{datetime.datetime.now().strftime('%Y%m%d_%H%M')}.pdf")

    return send_file(
        io.BytesIO(pdf_bytes),
        mimetype      = "application/pdf",
        as_attachment = not inline,
        download_name = fname,
    )


# ══════════════════════════════════════════════════════════════════════════════
# OS PRIORITY
# ══════════════════════════════════════════════════════════════════════════════

@app.get("/api/system/priority")
def system_priority():
    """Current process priority: level, method, admin status, pid, RAM."""
    return jsonify(get_priority_info())


@app.post("/api/system/priority/high")
def system_set_high():
    """Manually raise to high priority (auto-done by ingest/report)."""
    result = set_high_priority()
    return jsonify(result), (200 if result["success"] else 500)


@app.post("/api/system/priority/reset")
def system_reset_priority():
    """Reset priority to normal."""
    return jsonify(reset_priority())


# ══════════════════════════════════════════════════════════════════════════════
# BOOT
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    initialize_database()

    all_h5 = glob.glob(os.path.join(DATA_DIR, "**", "*.h5"), recursive=True)
    if all_h5:
        log.info(f"Boot scan: {len(all_h5)} H5 files found, registering all...")
        upsert_patient_files(DATA_DIR, all_h5)
    else:
        log.warning("No H5 files found — ingest an EDF first")

    # ── Acquisition transports ────────────────────────────────────────────────
    run_watcher()             # SD-card / generic data/incoming/ watcher
    start_bt_watcher()         # OBEX-based BT receiver (phone "Share" flow)
    start_rfcomm_server()      # RFCOMM BT receiver (bt_sender.py companion)
    # USB listener is started on-demand via POST /api/usb/connect, not at boot,
    # to avoid grabbing a serial port the user might want for something else.

    log.info(f"Holter ECG API v11  →  http://localhost:{PORT}")
    log.info(f"LAN IP: {_get_lan_ip()}:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=True)
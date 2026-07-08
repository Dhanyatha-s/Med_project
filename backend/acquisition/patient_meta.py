"""
patient_meta.py — Patient demographic extraction for api.py
─────────────────────────────────────────────────────────────────────────────
Adds:
  - extract_patient_meta(edf_path)  → dict with patient_id, name, age, sex
  - make_patient_meta_blueprint()   → Flask blueprint exposing
        GET /api/patient/<patient_id>/meta

Demographics are resolved in this priority order:
  1. <edf_stem>.meta.json sidecar (written by bt_receiver_rfcomm.py — has
     name/age/sex straight from the sender's header, most reliable).
  2. EDF header itself via pyedflib:
       - patient_code   → patient_id
       - patient_name   → name (underscores converted back to spaces)
       - sex            → 'M'/'F' via getSex()
       - birthdate      → age computed as (today - birthdate).years
       - patient_additional → fallback "AGE=.. SEX=.." string written by
         generate_48hr_edf.py, parsed if birthdate/sex are missing/odd.

Integration into api.py:
─────────────────────────────────────────────────────────────────────────────
  from acquisition.patient_meta import make_patient_meta_blueprint, \\
                                          extract_patient_meta

  app.register_blueprint(make_patient_meta_blueprint())

  # New route:
  GET /api/patient/<patient_id>/meta
      → {
          "patient_id": "P001",
          "name": "John Doe",
          "age": 45,
          "sex": "M",
          "source": "meta_json" | "edf_header" | "unknown"
        }

Optionally, call extract_patient_meta() from ingest_stream.py's
auto_register_patient() call so the DB is populated automatically on ingest.
"""

import os
import re
import json
import logging
import datetime
import pyedflib

log = logging.getLogger(__name__)

_DATA_DIR    = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))
_INCOMING    = os.path.join(_DATA_DIR, "incoming")
_PATIENTS_DIR = os.path.join(_DATA_DIR, "patients")


# ── Core extraction ────────────────────────────────────────────────────────

def extract_patient_meta(edf_path: str) -> dict:
    """
    Return {"patient_id", "name", "age", "sex", "source"} for a given EDF
    file path. Checks for a sidecar .meta.json first, then falls back to
    parsing the EDF header directly with pyedflib.
    """
    result = {
        "patient_id": None,
        "name":       None,
        "age":        None,
        "sex":        None,
        "source":     "unknown",
    }

    # 1. Sidecar JSON (written by bt_receiver_rfcomm.py)
    meta_path = os.path.splitext(edf_path)[0] + ".meta.json"
    if os.path.exists(meta_path):
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            result.update({
                "patient_id": meta.get("patient_id"),
                "name":       meta.get("patient_name"),
                "age":        meta.get("age"),
                "sex":        _norm_sex(meta.get("sex")),
                "source":     "meta_json",
            })
            if result["patient_id"] and result["age"] is not None:
                return result
        except Exception as e:
            log.warning(f"[patient_meta] Failed to read {meta_path}: {e}")

    # 2. EDF header via pyedflib
    if os.path.exists(edf_path):
        try:
            header_meta = _meta_from_edf_header(edf_path)
            # Fill in anything still missing from sidecar (sidecar wins)
            for k, v in header_meta.items():
                if result.get(k) in (None, "unknown") and v is not None:
                    result[k] = v
            if result["source"] == "unknown":
                result["source"] = "edf_header"
        except Exception as e:
            log.warning(f"[patient_meta] Failed to parse EDF header {edf_path}: {e}")

    return result


def _meta_from_edf_header(edf_path: str) -> dict:
    

    out = {"patient_id": None, "name": None, "age": None, "sex": None}

    f = pyedflib.EdfReader(edf_path)
    try:
        code = f.getPatientCode().strip()
        name = f.getPatientName().strip().replace("_", " ")
        additional = ""
        try:
            additional = f.getPatientAdditional().strip()
        except Exception:
            pass

        out["patient_id"] = code or None
        out["name"]       = name or None

        # Sex
        sex_val = None
        try:
            sex_raw = f.getSex()   # pyedflib: 'M'/'F' or 1/0 depending on version
            sex_val = _norm_sex(sex_raw)
        except Exception:
            pass

        # Age via birthdate
        age_val = None
        try:
            bdate = f.getBirthdate()
            if bdate:
                bdate_obj = _parse_birthdate(bdate)
                if bdate_obj:
                    today = datetime.date.today()
                    age_val = today.year - bdate_obj.year - (
                        (today.month, today.day) < (bdate_obj.month, bdate_obj.day)
                    )
        except Exception:
            pass

        # Fallback: parse "AGE=45 SEX=M" from patient_additional
        if (age_val is None or sex_val is None) and additional:
            m_age = re.search(r"AGE=(\d+)", additional)
            m_sex = re.search(r"SEX=([MF])", additional)
            if age_val is None and m_age:
                age_val = int(m_age.group(1))
            if sex_val is None and m_sex:
                sex_val = m_sex.group(1)

        out["age"] = age_val
        out["sex"] = sex_val
    finally:
        try:
            f._close()
        except Exception:
            pass

    return out


def _norm_sex(val) -> str | None:
    if val is None:
        return None
    s = str(val).strip().upper()
    if s in ("M", "MALE", "1"):
        return "M"
    if s in ("F", "FEMALE", "0"):
        return "F"
    return s[:1] if s else None


def _parse_birthdate(bdate):
    """pyedflib getBirthdate() may return a datetime.date, datetime.datetime,
    or a string like 'dd-MMM-yyyy'. Normalise to datetime.date."""
    if isinstance(bdate, datetime.datetime):
        return bdate.date()
    if isinstance(bdate, datetime.date):
        return bdate
    if isinstance(bdate, str) and bdate.strip():
        for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d/%m/%Y"):
            try:
                return datetime.datetime.strptime(bdate.strip(), fmt).date()
            except ValueError:
                continue
    return None


# ── Lookup helpers ─────────────────────────────────────────────────────────

def find_edf_for_patient(patient_id: str) -> str | None:
    """
    Best-effort: find the most relevant EDF file for a patient.
    Checks data/incoming/ first (most recent upload), then
    data/patients/<id>/ for any .edf left alongside the .h5.
    """
    patient_id = patient_id.upper()
    candidates = []

    for d in (_INCOMING, os.path.join(_PATIENTS_DIR, patient_id)):
        if not os.path.isdir(d):
            continue
        for fname in os.listdir(d):
            if fname.upper().startswith(patient_id) and fname.lower().endswith((".edf", ".edf+")):
                candidates.append(os.path.join(d, fname))

    if not candidates:
        return None

    # Most recently modified wins
    candidates.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    return candidates[0]


# ── Flask blueprint ────────────────────────────────────────────────────────

def make_patient_meta_blueprint():
    """
    Returns a Flask blueprint exposing:
        GET /api/patient/<patient_id>/meta

    Register in api.py:
        from acquisition.patient_meta import make_patient_meta_blueprint
        app.register_blueprint(make_patient_meta_blueprint())
    """
    from flask import Blueprint, jsonify

    bp = Blueprint("patient_meta", __name__)

    @bp.get("/api/patient/<patient_id>/meta")
    def api_patient_meta(patient_id):
        patient_id = patient_id.upper()
        edf_path = find_edf_for_patient(patient_id)

        if not edf_path:
            return jsonify({
                "patient_id": patient_id,
                "name": None,
                "age": None,
                "sex": None,
                "source": "not_found",
                "error": "No EDF or metadata file found for this patient",
            }), 404

        meta = extract_patient_meta(edf_path)
        # patient_id in the response should reflect the request, not a
        # possibly-mismatched header value
        meta["patient_id"] = meta.get("patient_id") or patient_id
        return jsonify(meta)

    return bp
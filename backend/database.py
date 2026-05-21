"""
database.py  —  SQLite patient store
Fully automated: any new patient arriving via WiFi/BT/USB
is automatically registered. No manual DB commands needed.
"""

import os
import glob
import logging
import sqlite3
import datetime

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "holter.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def initialize_database():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS patients (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                age        INTEGER DEFAULT 0,
                sex        TEXT    DEFAULT 'Unknown',
                dob        TEXT    DEFAULT '',
                created_at TEXT    DEFAULT '',
                h5_3lead   TEXT    DEFAULT '',
                h5_12lead  TEXT    DEFAULT ''
            )
        """)
        # P001 — 12-lead patient
        conn.execute("""
            INSERT OR IGNORE INTO patients
              (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead)
            VALUES (?,?,?,?,?,?,?,?)
        """, (
            "P001", "Test Patient", 45, "M", "1981-01-01", "2026-01-01",
            "ecg_48hr_3leads_converted.h5",
            "ecg_48hr_12leads_converted.h5",
        ))
        # P002 — 3-lead patient
        conn.execute("""
            INSERT OR IGNORE INTO patients
              (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead)
            VALUES (?,?,?,?,?,?,?,?)
        """, (
            "P002", "Arjun Sharma", 62, "M", "1964-05-20", "2026-01-15",
            "ecg_48hr_3leads_converted.h5",
            "",
        ))
        conn.commit()
    log.info("Database ready.")


# ── AUTO-REGISTER any new patient ────────────────────────────────────────────

def auto_register_patient(patient_id: str, name: str = None,
                           h5_rel_path: str = None, n_leads: int = 0):
    """
    Called automatically after every WiFi / BT / USB / SD ingest.
    - Inserts the patient if they don't exist yet (INSERT OR IGNORE)
    - Updates the correct H5 column (h5_12lead or h5_3lead)
    - Never overwrites existing demographic data
    """
    display_name = name if name and name not in ("TestPatient", "Unknown", "") \
                        else patient_id
    created_at   = datetime.datetime.now().strftime("%Y-%m-%d")
    col          = "h5_12lead" if n_leads == 12 else "h5_3lead"

    with get_conn() as conn:
        # Step 1: Insert if new — never fails if already exists
        conn.execute("""
            INSERT OR IGNORE INTO patients
                (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead)
            VALUES (?, ?, 0, 'Unknown', '', ?, '', '')
        """, (patient_id, display_name, created_at))

        # Step 2: Update H5 path (always safe — patient now guaranteed to exist)
        if h5_rel_path:
            conn.execute(
                f"UPDATE patients SET {col}=? WHERE id=?",
                (h5_rel_path, patient_id)
            )

        conn.commit()

    log.info(f"[DB] Auto-registered: {patient_id} | {col}={h5_rel_path}")


# ── SCAN & REGISTER all H5 files on disk ─────────────────────────────────────

def upsert_patient_files(data_dir: str, h5_paths: list):
    """
    Called at api.py boot. Scans all H5 files and registers every
    patient found on disk into the DB automatically.
    Works for P001, P002, P003 ... any patient ID.
    """
    import h5py
    import re

    for path in h5_paths:
        rel   = os.path.relpath(path, data_dir)
        fname = os.path.basename(path)

        # Try to extract patient ID from folder structure: patients/PXXX/ecg.h5
        parts     = rel.replace("\\", "/").split("/")
        patient_id = None
        for part in parts:
            if re.match(r"^P\d+$", part, re.IGNORECASE):
                patient_id = part.upper()
                break

        # Fallback: try filename e.g. P003_ecg.h5
        if not patient_id:
            m = re.match(r"^(P\d+)", fname.upper())
            if m:
                patient_id = m.group(1)

        if not patient_id:
            log.warning(f"  Cannot determine patient ID for {rel} — skipping")
            continue

        try:
            with h5py.File(path, "r") as f:
                n_leads = int(f["ecg"].shape[1])
                name    = str(f.attrs.get("patient_name", patient_id))
        except Exception as e:
            log.warning(f"  Cannot read {rel}: {e}")
            continue

        auto_register_patient(
            patient_id  = patient_id,
            name        = name,
            h5_rel_path = rel,
            n_leads     = n_leads,
        )

    log.info("[DB] Boot scan complete — all patients registered.")


# ── STANDARD QUERIES ──────────────────────────────────────────────────────────

def fetch_all_patients():
    with get_conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM patients").fetchall()]


def fetch_patient(pid: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM patients WHERE id=?", (pid,)).fetchone()
        return dict(row) if row else None


if __name__ == "__main__":
    initialize_database()
    for p in fetch_all_patients():
        print(p)
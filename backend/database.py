# """
# database.py  —  SQLite patient store
# Fully automated: any new patient arriving via WiFi/BT/USB
# is automatically registered. No manual DB commands needed.
# """
# import h5py
# import re
# import os
# import glob
# import logging
# import sqlite3
# import datetime

# logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
# log = logging.getLogger(__name__)

# DB_PATH = os.path.join(os.path.dirname(__file__), "data", "holter.db")


# def get_conn():
#     conn = sqlite3.connect(DB_PATH)
#     conn.row_factory = sqlite3.Row
#     return conn


# def initialize_database():
#     os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
#     with get_conn() as conn:
#         # ── patients ──────────────────────────────────────────────────────────
#         conn.execute("""
#             CREATE TABLE IF NOT EXISTS patients (
#                 id         TEXT PRIMARY KEY,
#                 name       TEXT NOT NULL,
#                 age        INTEGER DEFAULT 0,
#                 sex        TEXT    DEFAULT 'Unknown',
#                 dob        TEXT    DEFAULT '',
#                 created_at TEXT    DEFAULT '',
#                 h5_3lead   TEXT    DEFAULT '',
#                 h5_12lead  TEXT    DEFAULT '',
#                 source     TEXT    DEFAULT ''
#             )
#         """)

#         # ── safe migration: add source column if upgrading from old schema ────
#         try:
#             conn.execute("ALTER TABLE patients ADD COLUMN source TEXT DEFAULT ''")
#             conn.commit()
#             log.info("[DB] Migrated: added 'source' column to patients table.")
#         except Exception:
#             pass  # column already exists — no-op

#         # ── annotations ───────────────────────────────────────────────────────
#         # timestamp_sec : position in the ECG recording (seconds from start).
#         #                 NULL = general note not tied to a specific time.
#         # type          : "diary" | "device" | "auto"
#         # source        : "doctor" | "device" | "system"
#         conn.execute("""
#             CREATE TABLE IF NOT EXISTS annotations (
#                 id            INTEGER PRIMARY KEY AUTOINCREMENT,
#                 patient_id    TEXT    NOT NULL,
#                 timestamp_sec REAL    DEFAULT NULL,
#                 type          TEXT    DEFAULT 'diary',
#                 note          TEXT    NOT NULL DEFAULT '',
#                 source        TEXT    DEFAULT 'doctor',
#                 created_at    TEXT    DEFAULT '',
#                 FOREIGN KEY (patient_id) REFERENCES patients(id)
#             )
#         """)
#         conn.execute(
#             "CREATE INDEX IF NOT EXISTS idx_ann_patient "
#             "ON annotations(patient_id)"
#         )

#         # ── seed patients ─────────────────────────────────────────────────────
#         conn.execute("""
#             INSERT OR IGNORE INTO patients
#               (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead, source)
#             VALUES (?,?,?,?,?,?,?,?,?)
#         """, (
#             "P001", "Test Patient", 45, "M", "1981-01-01", "2026-01-01",
#             "ecg_48hr_3leads_converted.h5",
#             "ecg_48hr_12leads_converted.h5",
#             "",
#         ))
#         conn.execute("""
#             INSERT OR IGNORE INTO patients
#               (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead, source)
#             VALUES (?,?,?,?,?,?,?,?,?)
#         """, (
#             "P002", "Arjun Sharma", 62, "M", "1964-05-20", "2026-01-15",
#             "ecg_48hr_3leads_converted.h5",
#             "",
#             "",
#         ))
#         conn.commit()
#     log.info("Database ready (patients + annotations).")


# # ── Path helpers ───────────────────────────────────────────────────────────────

# def _resolve_h5_path(rel_or_abs: str, data_dir: str | None = None) -> str:
#     if not rel_or_abs:
#         return ""
#     if os.path.isabs(rel_or_abs):
#         return rel_or_abs
#     base = data_dir or os.path.join(os.path.dirname(__file__), "data")
#     return os.path.normpath(os.path.join(base, rel_or_abs))


# # ── AUTO-REGISTER ─────────────────────────────────────────────────────────────

# def auto_register_patient(patient_id: str, name: str = None,
#                            h5_rel_path: str = None, n_leads: int = 0,
#                            data_dir: str | None = None,
#                            source_method: str = ""):           # ← NEW param
#     """
#     Called automatically after every WiFi / BT / USB / SD ingest.
#     Stores the H5 path as ABSOLUTE so it works from any working directory.
#     Also stores the transfer source (wifi / bt / usb / sd).
#     """
#     display_name = name if name and name not in ("TestPatient", "Unknown", "") \
#                         else patient_id
#     created_at   = datetime.datetime.now().strftime("%Y-%m-%d")
#     col          = "h5_12lead" if n_leads == 12 else "h5_3lead"

#     abs_path = _resolve_h5_path(h5_rel_path or "", data_dir) if h5_rel_path else ""

#     with get_conn() as conn:
#         # Insert new patient row (no-op if already exists)
#         conn.execute("""
#             INSERT OR IGNORE INTO patients
#                 (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead, source)
#             VALUES (?, ?, 0, 'Unknown', '', ?, '', '', ?)
#         """, (patient_id, display_name, created_at, source_method))

#         # Always update h5 path; only update source when a real method is known
#         updates = []
#         params  = []
#         if abs_path:
#             updates.append(f"{col}=?")
#             params.append(abs_path)
#         if source_method:                                      # ← NEW: save source
#             updates.append("source=?")
#             params.append(source_method)
#         if updates:
#             params.append(patient_id)
#             conn.execute(
#                 f"UPDATE patients SET {', '.join(updates)} WHERE id=?",
#                 params
#             )
#         conn.commit()

#     log.info(f"[DB] Auto-registered: {patient_id} | {col}={abs_path} | source={source_method}")


# def upsert_patient_files(data_dir: str, h5_paths: list):
#     """
#     Boot scan: registers every H5 file found on disk.
#     Stores absolute paths. Source left blank — unknown at boot time.
#     """
    

#     for path in h5_paths:
#         abs_path = os.path.abspath(path)
#         fname    = os.path.basename(path)
#         rel      = os.path.relpath(path, data_dir)

#         parts      = rel.replace("\\", "/").split("/")
#         patient_id = None
#         for part in parts:
#             if re.match(r"^P\d+$", part, re.IGNORECASE):
#                 patient_id = part.upper()
#                 break
#         if not patient_id:
#             m = re.match(r"^(P\d+)", fname.upper())
#             if m:
#                 patient_id = m.group(1)
#         if not patient_id:
#             log.warning(f"  Cannot determine patient ID for {rel} — skipping")
#             continue

#         try:
#             with h5py.File(abs_path, "r") as f:
#                 n_leads = int(f["ecg"].shape[1])
#                 name    = str(f.attrs.get("patient_name", patient_id))
#         except Exception as e:
#             log.warning(f"  Cannot read {rel}: {e}")
#             continue

#         auto_register_patient(
#             patient_id    = patient_id,
#             name          = name,
#             h5_rel_path   = abs_path,
#             n_leads       = n_leads,
#             data_dir      = data_dir,
#             source_method = "",        # source unknown at boot scan
#         )

#     log.info("[DB] Boot scan complete.")


# # ── PATIENT QUERIES ────────────────────────────────────────────────────────────

# def fetch_all_patients():
#     with get_conn() as conn:
#         return [dict(r) for r in
#                 conn.execute("""
#                     SELECT id, name, age, sex, dob, created_at,
#                            h5_3lead, h5_12lead, source
#                     FROM   patients
#                     ORDER  BY id
#                 """).fetchall()]


# def fetch_patient(pid: str):
#     with get_conn() as conn:
#         row = conn.execute(
#             """SELECT id, name, age, sex, dob, created_at,
#                       h5_3lead, h5_12lead, source
#                FROM   patients WHERE id=?""",
#             (pid,)
#         ).fetchone()
#         return dict(row) if row else None


# # ── ANNOTATION CRUD ────────────────────────────────────────────────────────────

# def fetch_annotations(patient_id: str) -> list:
#     with get_conn() as conn:
#         rows = conn.execute("""
#             SELECT * FROM annotations
#             WHERE  patient_id = ?
#             ORDER  BY COALESCE(timestamp_sec, 999999999) ASC, id ASC
#         """, (patient_id,)).fetchall()
#         return [dict(r) for r in rows]


# def create_annotation(patient_id: str, note: str,
#                        timestamp_sec=None,
#                        ann_type: str  = "diary",
#                        source: str    = "doctor") -> dict:
#     created_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
#     with get_conn() as conn:
#         cur = conn.execute("""
#             INSERT INTO annotations
#                 (patient_id, timestamp_sec, type, note, source, created_at)
#             VALUES (?, ?, ?, ?, ?, ?)
#         """, (patient_id, timestamp_sec, ann_type, note, source, created_at))
#         conn.commit()
#         row = conn.execute(
#             "SELECT * FROM annotations WHERE id=?", (cur.lastrowid,)
#         ).fetchone()
#         return dict(row)


# def update_annotation(ann_id: int,
#                        note: str        = None,
#                        timestamp_sec    = None) -> dict | None:
#     with get_conn() as conn:
#         if note is not None:
#             conn.execute(
#                 "UPDATE annotations SET note=? WHERE id=?", (note, ann_id)
#             )
#         if timestamp_sec is not None:
#             conn.execute(
#                 "UPDATE annotations SET timestamp_sec=? WHERE id=?",
#                 (timestamp_sec, ann_id)
#             )
#         conn.commit()
#         row = conn.execute(
#             "SELECT * FROM annotations WHERE id=?", (ann_id,)
#         ).fetchone()
#         return dict(row) if row else None


# def delete_annotation(ann_id: int) -> bool:
#     with get_conn() as conn:
#         cur = conn.execute(
#             "DELETE FROM annotations WHERE id=?", (ann_id,)
#         )
#         conn.commit()
#         return cur.rowcount > 0


# def import_device_events(patient_id: str, events: list) -> int:
#     created_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
#     count = 0
#     with get_conn() as conn:
#         for ev in events:
#             conn.execute("""
#                 INSERT INTO annotations
#                     (patient_id, timestamp_sec, type, note, source, created_at)
#                 VALUES (?, ?, 'device', ?, 'device', ?)
#             """, (patient_id,
#                   ev.get("timestamp_sec"),
#                   ev.get("note", "Device event"),
#                   created_at))
#             count += 1
#         conn.commit()
#     return count


# if __name__ == "__main__":
#     initialize_database()
#     for p in fetch_all_patients():
#         print(p)

# =====================================================================================
# =====================================================================================
# =======================================================================================
"""
database.py  —  SQLite patient store
Fully automated: any new patient arriving via WiFi/BT/USB
is automatically registered. No manual DB commands needed.

v2 — auto_register_patient now accepts optional age/sex (e.g. extracted
from BT metadata or EDF header via acquisition.patient_meta). Existing
non-default values are never overwritten (manual PATCH edits win).
"""
import h5py
import re
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
        # ── patients ──────────────────────────────────────────────────────────
        conn.execute("""
            CREATE TABLE IF NOT EXISTS patients (
                id         TEXT PRIMARY KEY,
                name       TEXT NOT NULL,
                age        INTEGER DEFAULT 0,
                sex        TEXT    DEFAULT 'Unknown',
                dob        TEXT    DEFAULT '',
                created_at TEXT    DEFAULT '',
                h5_3lead   TEXT    DEFAULT '',
                h5_12lead  TEXT    DEFAULT '',
                source     TEXT    DEFAULT ''
            )
        """)

        # ── safe migration: add source column if upgrading from old schema ────
        try:
            conn.execute("ALTER TABLE patients ADD COLUMN source TEXT DEFAULT ''")
            conn.commit()
            log.info("[DB] Migrated: added 'source' column to patients table.")
        except Exception:
            pass  # column already exists — no-op

        # ── annotations ───────────────────────────────────────────────────────
        # timestamp_sec : position in the ECG recording (seconds from start).
        #                 NULL = general note not tied to a specific time.
        # type          : "diary" | "device" | "auto"
        # source        : "doctor" | "device" | "system"
        conn.execute("""
            CREATE TABLE IF NOT EXISTS annotations (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                patient_id    TEXT    NOT NULL,
                timestamp_sec REAL    DEFAULT NULL,
                type          TEXT    DEFAULT 'diary',
                note          TEXT    NOT NULL DEFAULT '',
                source        TEXT    DEFAULT 'doctor',
                created_at    TEXT    DEFAULT '',
                FOREIGN KEY (patient_id) REFERENCES patients(id)
            )
        """)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ann_patient "
            "ON annotations(patient_id)"
        )

        # ── seed patients ─────────────────────────────────────────────────────
        conn.execute("""
            INSERT OR IGNORE INTO patients
              (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead, source)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (
            "P001", "Test Patient", 45, "M", "1981-01-01", "2026-01-01",
            "ecg_48hr_3leads_converted.h5",
            "ecg_48hr_12leads_converted.h5",
            "",
        ))
        conn.execute("""
            INSERT OR IGNORE INTO patients
              (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead, source)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (
            "P002", "Arjun Sharma", 62, "M", "1964-05-20", "2026-01-15",
            "ecg_48hr_3leads_converted.h5",
            "",
            "",
        ))
        conn.commit()
    log.info("Database ready (patients + annotations).")


# ── Path helpers ───────────────────────────────────────────────────────────────

def _resolve_h5_path(rel_or_abs: str, data_dir: str | None = None) -> str:
    if not rel_or_abs:
        return ""
    if os.path.isabs(rel_or_abs):
        return rel_or_abs
    base = data_dir or os.path.join(os.path.dirname(__file__), "data")
    return os.path.normpath(os.path.join(base, rel_or_abs))


# ── AUTO-REGISTER ─────────────────────────────────────────────────────────────

def auto_register_patient(patient_id: str, name: str = None,
                           h5_rel_path: str = None, n_leads: int = 0,
                           data_dir: str | None = None,
                           source_method: str = "",
                           age=None, sex=None):
    """
    Called automatically after every WiFi / BT / USB / SD ingest.
    Stores the H5 path as ABSOLUTE so it works from any working directory.
    Also stores the transfer source (wifi / bt / usb / sd) and, if known,
    patient age/sex (e.g. extracted from BT metadata or EDF header via
    acquisition.patient_meta.extract_patient_meta).

    Existing non-default age/sex/name values are NEVER overwritten —
    manual PATCH edits via /api/patients/<id> always win over auto-detected
    values from a later re-ingest.
    """
    display_name = name if name and name not in ("TestPatient", "Unknown", "") \
                        else patient_id
    created_at   = datetime.datetime.now().strftime("%Y-%m-%d")
    col          = "h5_12lead" if n_leads == 12 else "h5_3lead"

    abs_path = _resolve_h5_path(h5_rel_path or "", data_dir) if h5_rel_path else ""

    with get_conn() as conn:
        # Insert new patient row (no-op if already exists)
        conn.execute("""
            INSERT OR IGNORE INTO patients
                (id, name, age, sex, dob, created_at, h5_3lead, h5_12lead, source)
            VALUES (?, ?, 0, 'Unknown', '', ?, '', '', ?)
        """, (patient_id, display_name, created_at, source_method))

        updates = []
        params  = []

        # Always update h5 path
        if abs_path:
            updates.append(f"{col}=?")
            params.append(abs_path)

        # Only update source when a real method is known
        if source_method:
            updates.append("source=?")
            params.append(source_method)

        # Conditionally update age/sex/name — only if currently unset
        if age is not None or sex is not None or (name and display_name != patient_id):
            row = conn.execute(
                "SELECT age, sex, name FROM patients WHERE id=?", (patient_id,)
            ).fetchone()
            if row is not None:
                if age is not None and (row["age"] in (0, None)):
                    try:
                        updates.append("age=?")
                        params.append(int(age))
                    except (TypeError, ValueError):
                        pass
                if sex is not None and (row["sex"] in ("Unknown", "", None)):
                    updates.append("sex=?")
                    params.append(str(sex))
                # Upgrade display name from placeholder (== patient_id) to
                # a real name, if one is now known
                if (name and display_name != patient_id
                        and row["name"] == patient_id):
                    updates.append("name=?")
                    params.append(display_name)

        if updates:
            params.append(patient_id)
            conn.execute(
                f"UPDATE patients SET {', '.join(updates)} WHERE id=?",
                params
            )
        conn.commit()

    log.info(
        f"[DB] Auto-registered: {patient_id} | {col}={abs_path} | "
        f"source={source_method} | age={age} | sex={sex}"
    )


def upsert_patient_files(data_dir: str, h5_paths: list):
    """
    Boot scan: registers every H5 file found on disk.
    Stores absolute paths. Source left blank — unknown at boot time.
    """

    for path in h5_paths:
        abs_path = os.path.abspath(path)
        fname    = os.path.basename(path)
        rel      = os.path.relpath(path, data_dir)

        parts      = rel.replace("\\", "/").split("/")
        patient_id = None
        for part in parts:
            if re.match(r"^P\d+$", part, re.IGNORECASE):
                patient_id = part.upper()
                break
        if not patient_id:
            m = re.match(r"^(P\d+)", fname.upper())
            if m:
                patient_id = m.group(1)
        if not patient_id:
            log.warning(f"  Cannot determine patient ID for {rel} — skipping")
            continue

        try:
            with h5py.File(abs_path, "r") as f:
                n_leads = int(f["ecg"].shape[1])
                name    = str(f.attrs.get("patient_name", patient_id))
        except Exception as e:
            log.warning(f"  Cannot read {rel}: {e}")
            continue

        auto_register_patient(
            patient_id    = patient_id,
            name          = name,
            h5_rel_path   = abs_path,
            n_leads       = n_leads,
            data_dir      = data_dir,
            source_method = "",        # source unknown at boot scan
        )

    log.info("[DB] Boot scan complete.")


# ── PATIENT QUERIES ────────────────────────────────────────────────────────────

def fetch_all_patients():
    with get_conn() as conn:
        return [dict(r) for r in
                conn.execute("""
                    SELECT id, name, age, sex, dob, created_at,
                           h5_3lead, h5_12lead, source
                    FROM   patients
                    ORDER  BY id
                """).fetchall()]


def fetch_patient(pid: str):
    with get_conn() as conn:
        row = conn.execute(
            """SELECT id, name, age, sex, dob, created_at,
                      h5_3lead, h5_12lead, source
               FROM   patients WHERE id=?""",
            (pid,)
        ).fetchone()
        return dict(row) if row else None


# ── ANNOTATION CRUD ────────────────────────────────────────────────────────────

def fetch_annotations(patient_id: str) -> list:
    with get_conn() as conn:
        rows = conn.execute("""
            SELECT * FROM annotations
            WHERE  patient_id = ?
            ORDER  BY COALESCE(timestamp_sec, 999999999) ASC, id ASC
        """, (patient_id,)).fetchall()
        return [dict(r) for r in rows]


def create_annotation(patient_id: str, note: str,
                       timestamp_sec=None,
                       ann_type: str  = "diary",
                       source: str    = "doctor") -> dict:
    created_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        cur = conn.execute("""
            INSERT INTO annotations
                (patient_id, timestamp_sec, type, note, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (patient_id, timestamp_sec, ann_type, note, source, created_at))
        conn.commit()
        row = conn.execute(
            "SELECT * FROM annotations WHERE id=?", (cur.lastrowid,)
        ).fetchone()
        return dict(row)


def update_annotation(ann_id: int,
                       note: str        = None,
                       timestamp_sec    = None) -> dict | None:
    with get_conn() as conn:
        if note is not None:
            conn.execute(
                "UPDATE annotations SET note=? WHERE id=?", (note, ann_id)
            )
        if timestamp_sec is not None:
            conn.execute(
                "UPDATE annotations SET timestamp_sec=? WHERE id=?",
                (timestamp_sec, ann_id)
            )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM annotations WHERE id=?", (ann_id,)
        ).fetchone()
        return dict(row) if row else None


def delete_annotation(ann_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute(
            "DELETE FROM annotations WHERE id=?", (ann_id,)
        )
        conn.commit()
        return cur.rowcount > 0


def import_device_events(patient_id: str, events: list) -> int:
    created_at = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    count = 0
    with get_conn() as conn:
        for ev in events:
            conn.execute("""
                INSERT INTO annotations
                    (patient_id, timestamp_sec, type, note, source, created_at)
                VALUES (?, ?, 'device', ?, 'device', ?)
            """, (patient_id,
                  ev.get("timestamp_sec"),
                  ev.get("note", "Device event"),
                  created_at))
            count += 1
        conn.commit()
    return count


if __name__ == "__main__":
    initialize_database()
    for p in fetch_all_patients():
        print(p)
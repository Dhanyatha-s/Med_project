"""
progress_store.py  —  SQLite ingest session tracker
─────────────────────────────────────────────────────────────────────────────
Tracks every data acquisition session so the API can answer
GET /api/transfer/status/<session_id> at any time, even across restarts.

Used by: ingest_stream.py (writes), api.py (reads), wifi_receiver.py (reads)
"""

import os, json, sqlite3, logging, uuid
from datetime import datetime, timezone

log = logging.getLogger(__name__)

_DB_PATH = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "data", "holter.db")
)


def _conn():
    os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
    c = sqlite3.connect(_DB_PATH, check_same_thread=False)
    c.row_factory = sqlite3.Row
    return c


def _now():
    return datetime.now(timezone.utc).isoformat()


def initialise():
    with _conn() as c:
        c.execute("""
            CREATE TABLE IF NOT EXISTS ingest_sessions (
                session_id        TEXT PRIMARY KEY,
                patient_id        TEXT NOT NULL,
                status            TEXT NOT NULL DEFAULT 'receiving',
                bytes_received    INTEGER NOT NULL DEFAULT 0,
                bytes_total       INTEGER NOT NULL DEFAULT 0,
                samples_written   INTEGER NOT NULL DEFAULT 0,
                total_samples     INTEGER NOT NULL DEFAULT 0,
                seconds_available REAL    NOT NULL DEFAULT 0.0,
                lead_names        TEXT    NOT NULL DEFAULT '[]',
                sampling_rate     INTEGER NOT NULL DEFAULT 250,
                error_message     TEXT,
                source_method     TEXT    NOT NULL DEFAULT 'unknown',
                h5_path           TEXT,
                started_at        TEXT    NOT NULL,
                updated_at        TEXT    NOT NULL
            )
        """)
        c.commit()


def create_session(patient_id, bytes_total=0, source_method="unknown"):
    """Create a new session. Returns session_id string."""
    initialise()
    sid = str(uuid.uuid4())
    now = _now()
    with _conn() as c:
        c.execute("""
            INSERT INTO ingest_sessions
              (session_id, patient_id, status, bytes_total,
               source_method, started_at, updated_at)
            VALUES (?,?,?,?,?,?,?)
        """, (sid, patient_id, "receiving", bytes_total, source_method, now, now))
        c.commit()
    log.info(f"[progress] session {sid[:8]}  patient={patient_id}  method={source_method}")
    return sid


def update(session_id, **fields):
    """Update any subset of fields. Always refreshes updated_at."""
    allowed = {
        "status","bytes_received","bytes_total","samples_written",
        "total_samples","seconds_available","lead_names","sampling_rate",
        "error_message","source_method","h5_path",
    }
    safe = {k: v for k, v in fields.items() if k in allowed}
    if not safe:
        return
    if "lead_names" in safe and isinstance(safe["lead_names"], list):
        safe["lead_names"] = json.dumps(safe["lead_names"])
    safe["updated_at"] = _now()
    sets = ", ".join(f"{k}=?" for k in safe)
    with _conn() as c:
        c.execute(
            f"UPDATE ingest_sessions SET {sets} WHERE session_id=?",
            list(safe.values()) + [session_id]
        )
        c.commit()


def get(session_id):
    """Return session dict or None."""
    initialise()
    with _conn() as c:
        row = c.execute(
            "SELECT * FROM ingest_sessions WHERE session_id=?", (session_id,)
        ).fetchone()
    if not row:
        return None
    d = dict(row)
    try:
        d["lead_names"] = json.loads(d["lead_names"] or "[]")
    except Exception:
        d["lead_names"] = []
    d["pct_received"] = round(
        d["bytes_received"] / d["bytes_total"] * 100, 1
    ) if d["bytes_total"] > 0 else 0.0
    d["pct_written"] = round(
        d["samples_written"] / d["total_samples"] * 100, 1
    ) if d["total_samples"] > 0 else 0.0
    return d


def list_active():
    initialise()
    with _conn() as c:
        rows = c.execute("""
            SELECT session_id FROM ingest_sessions
            WHERE status NOT IN ('complete','error')
            ORDER BY started_at DESC
        """).fetchall()
    return [get(r["session_id"]) for r in rows]


def list_recent(limit=20):
    initialise()
    with _conn() as c:
        rows = c.execute("""
            SELECT session_id FROM ingest_sessions
            ORDER BY started_at DESC LIMIT ?
        """, (limit,)).fetchall()
    return [get(r["session_id"]) for r in rows]

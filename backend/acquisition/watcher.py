"""
watcher.py  —  data/incoming/ folder monitor
─────────────────────────────────────────────────────────────────────────────
Monitors data/incoming/ using watchdog.
When any .edf file appears (from any transfer method), creates an IngestSession.

Patient assignment from filename:
  P001_recording.edf  → patient_id = P001
  P001_2026-01-15.edf → patient_id = P001
  recording.edf       → patient_id = UNKNOWN (prompt user to assign in UI)

Run as standalone:  python -m acquisition.watcher
Or import and call: run_watcher() in a background thread from api.py
"""

import os
import re
import time
import logging
import threading
import shutil
from pathlib import Path

from watchdog.observers import Observer
from watchdog.events    import FileSystemEventHandler

from acquisition.ingest_stream import IngestSession

log = logging.getLogger(__name__)

_DATA_DIR       = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))
_INCOMING_DIR   = os.path.join(_DATA_DIR, "incoming")
_PROCESSED_DIR  = os.path.join(_DATA_DIR, "incoming", "processed")
_STABLE_WAIT    = 2.0    # seconds to wait for file size to stabilise
_STABLE_RETRIES = 10     # max retries before giving up


def _extract_patient_id(filename: str) -> str:
    """
    Extract patient ID from filename.
    Examples:
      P001_recording.edf        → P001
      P002_2026-01-15_09h30.edf → P002
      holter_recording.edf      → UNKNOWN
    """
    stem  = Path(filename).stem.upper()
    match = re.match(r"^(P\d+)", stem)
    if match:
        return match.group(1)
    # Try to find any pattern like P followed by 3 digits anywhere in name
    match = re.search(r"\b(P\d{3,})\b", stem)
    if match:
        return match.group(1)
    return "UNKNOWN"


def _wait_for_stable(filepath: str) -> bool:
    """
    Wait until file size stops growing (transfer complete).
    Returns True if file is stable, False if timed out.
    """
    prev_size = -1
    for attempt in range(_STABLE_RETRIES):
        try:
            size = os.path.getsize(filepath)
        except OSError:
            time.sleep(_STABLE_WAIT)
            continue
        if size == prev_size and size > 0:
            return True
        prev_size = size
        time.sleep(_STABLE_WAIT)
    log.warning(f"[watcher] File did not stabilise: {filepath}")
    return False


class _EDFHandler(FileSystemEventHandler):

    def __init__(self, active_sessions: dict, lock: threading.Lock):
        super().__init__()
        self._active   = active_sessions
        self._lock     = lock
        self._seen     = set()   # filenames already being processed

    def on_created(self, event):
        if event.is_directory:
            return
        path = event.src_path
        if not path.lower().endswith((".edf", ".edf+")):
            return
        fname = os.path.basename(path)
        if fname in self._seen:
            return

        log.info(f"[watcher] Detected: {fname}")
        self._seen.add(fname)

        # Handle in background thread so watcher loop never blocks
        t = threading.Thread(
            target=self._handle,
            args=(path, fname),
            daemon=True,
            name=f"ingest-{fname[:12]}"
        )
        t.start()

    def on_moved(self, event):
        """Handle files moved into the directory (some BT clients do this)."""
        if not event.is_directory and event.dest_path.lower().endswith((".edf",".edf+")):
            self.on_created(type("E", (), {"is_directory": False, "src_path": event.dest_path})())

    def _handle(self, filepath: str, fname: str):
        """Wait for stability, then start IngestSession."""
        if not _wait_for_stable(filepath):
            log.error(f"[watcher] Giving up on unstable file: {fname}")
            self._seen.discard(fname)
            return

        patient_id = _extract_patient_id(fname)
        log.info(f"[watcher] Starting ingest: {fname} → patient {patient_id}")

        try:
            session = IngestSession(
                patient_id    = patient_id,
                source_path   = filepath,
                source_method = "sd",   # watcher = SD card or file drop
            )
            with self._lock:
                self._active[session.session_id] = session

            log.info(f"[watcher] Session {session.session_id[:8]} started for {fname}")

            # Wait for completion in this thread so we can move the file after
            while session.status not in ("complete", "error"):
                time.sleep(2)

            # Move processed file so watcher doesn't re-trigger it
            os.makedirs(_PROCESSED_DIR, exist_ok=True)
            dest = os.path.join(_PROCESSED_DIR, fname)
            # Add timestamp suffix if dest already exists
            if os.path.exists(dest):
                ts   = int(time.time())
                dest = os.path.join(_PROCESSED_DIR, f"{ts}_{fname}")
            shutil.move(filepath, dest)
            log.info(f"[watcher] Moved to processed: {os.path.basename(dest)}")

        except Exception as e:
            log.error(f"[watcher] Ingest failed for {fname}: {e}")
        finally:
            self._seen.discard(fname)


class EDFWatcher:
    """
    Watches data/incoming/ and triggers IngestSession for new EDF files.
    Use run_watcher() convenience function or instantiate directly.
    """

    def __init__(self):
        os.makedirs(_INCOMING_DIR,  exist_ok=True)
        os.makedirs(_PROCESSED_DIR, exist_ok=True)

        self._active_sessions: dict = {}
        self._lock            = threading.Lock()
        self._observer        = Observer()
        self._handler         = _EDFHandler(self._active_sessions, self._lock)

    def start(self):
        self._observer.schedule(self._handler, _INCOMING_DIR, recursive=False)
        self._observer.start()
        log.info(f"[watcher] Watching {_INCOMING_DIR}")

    def stop(self):
        self._observer.stop()
        self._observer.join()
        log.info("[watcher] Stopped.")

    def active_sessions(self) -> dict:
        with self._lock:
            return dict(self._active_sessions)

    def get_session(self, session_id: str):
        with self._lock:
            return self._active_sessions.get(session_id)


# ── Singleton watcher for use by api.py ──────────────────────────────────────
_watcher_instance: EDFWatcher | None = None


def get_watcher() -> EDFWatcher:
    """Return the singleton EDFWatcher, creating it if needed."""
    global _watcher_instance
    if _watcher_instance is None:
        _watcher_instance = EDFWatcher()
    return _watcher_instance


def run_watcher():
    """Start the watcher. Call this once from api.py startup."""
    w = get_watcher()
    w.start()
    return w


# ── CLI entry point ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys
    logging.basicConfig(
        level   = logging.INFO,
        format  = "%(asctime)s %(levelname)-7s %(name)s  %(message)s",
        datefmt = "%H:%M:%S",
    )
    log.info("Starting EDF folder watcher. Press Ctrl+C to stop.")
    watcher = EDFWatcher()
    watcher.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        watcher.stop()
        log.info("Watcher stopped.")
        sys.exit(0)

"""
bt_receiver.py  —  Bluetooth OBEX receiver for Holter EDF data
─────────────────────────────────────────────────────────────────────────────
Handles incoming Bluetooth file transfers and feeds them into the watcher
pipeline. Works on Windows, Linux (BlueZ), and macOS.

Strategy per platform:
  Windows  — Watch the OS Bluetooth Exchange folder (auto-configured by the
             installer) and move any .edf file to data/incoming/.
  Linux    — Use obexd (BlueZ OBEX daemon) to accept OBEX Push transfers,
             auto-accept .edf files, move to data/incoming/.
  macOS    — Watch ~/Downloads (Bluetooth files land here) and move .edf
             to data/incoming/.

The key insight: because watcher.py already handles data/incoming/, all
Bluetooth logic does is route the received .edf into that directory.
No IngestSession is created here — the watcher does it automatically.

Architecture:
─────────────────────────────────────────────────────────────────────────────
  Holter device (Bluetooth)
      │  OBEX Push (.edf file)
      ▼
  bt_receiver.py  ← this file
      │  shutil.move(received_edf, data/incoming/P001_filename.edf)
      ▼
  watcher.py  → IngestSession  →  3-thread pipeline  →  HDF5 / Blosc

Integration into api.py:
─────────────────────────────────────────────────────────────────────────────
  from acquisition.bt_receiver import make_bt_blueprint, start_bt_watcher, \
                                       stop_bt_watcher

  # In __main__ block (after run_watcher):
  start_bt_watcher()

  # Register blueprint:
  app.register_blueprint(make_bt_blueprint())

  # New routes added by the blueprint:
  GET  /api/bt/status      — current BT receiver state
  GET  /api/bt/devices     — paired BT devices (Linux/Windows)
  POST /api/bt/pair        — initiate pairing with a device
  POST /api/bt/start       — start accepting transfers
  POST /api/bt/stop        — stop accepting transfers

Testing without hardware:
─────────────────────────────────────────────────────────────────────────────
  Run the receiver:
      python -m acquisition.bt_receiver --patient P001

  Simulate a BT transfer (in a separate terminal):
      python acquisition/simulate_device.py --mode bt \\
          --edf data/P001_test_300s.edf

  Or manually copy an EDF to the BT receive folder:
      # Linux
      cp data/P001_test_300s.edf /tmp/bt_receive/P001_test_300s.edf

      # Windows
      copy data\\P001_test_300s.edf "%USERPROFILE%\\Documents\\Bluetooth Exchange\\P001_test_300s.edf"
"""

import os
import re
import sys
import time
import shutil
import logging
import platform
import argparse
import threading
from pathlib import Path

log = logging.getLogger(__name__)

# ── Platform detection ────────────────────────────────────────────────────────
_OS = platform.system()          # "Windows", "Linux", "Darwin"

# ── Data directories ──────────────────────────────────────────────────────────
_DATA_DIR    = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))
_INCOMING    = os.path.join(_DATA_DIR, "incoming")

# ── OS-specific BT receive folder defaults ────────────────────────────────────
def _default_bt_folder() -> str:
    if _OS == "Windows":
        # Windows stores received BT files in Documents\Bluetooth Exchange
        docs = os.environ.get("USERPROFILE", os.path.expanduser("~"))
        return os.path.join(docs, "Documents", "Bluetooth Exchange")
    elif _OS == "Darwin":
        # macOS — BT files land in ~/Downloads
        return os.path.join(os.path.expanduser("~"), "Downloads")
    else:
        # Linux — obexd default receive dir, or fallback staging
        xdg   = os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid() if hasattr(os, 'getuid') else 1000}")
        obexd = os.path.join(xdg, "obexd")
        if os.path.exists(obexd):
            return obexd
        return os.path.join(_DATA_DIR, "bt_receive")   # staging fallback

_BT_RECEIVE_FOLDER = _default_bt_folder()

# ── Module state ──────────────────────────────────────────────────────────────
_watcher_thread: threading.Thread | None = None
_stop_event       = threading.Event()
_status: dict = {
    "state":          "idle",     # idle | watching | error
    "platform":       _OS,
    "receive_folder": _BT_RECEIVE_FOLDER,
    "files_received": 0,
    "last_file":      None,
    "last_session_id": None,
    "error":          None,
    "obexd_running":  None,       # Linux only
}
_status_lock = threading.Lock()

_default_patient_id = "UNKNOWN"  # updated by start_bt_watcher()


# ── Public API ────────────────────────────────────────────────────────────────

def get_bt_status() -> dict:
    """Return current BT receiver state (thread-safe)."""
    with _status_lock:
        s = dict(_status)
    # Refresh obexd status on Linux
    if _OS == "Linux":
        s["obexd_running"] = _is_obexd_running()
    return s


def start_bt_watcher(
    receive_folder: str = None,
    patient_id:     str = "UNKNOWN",
) -> bool:
    """
    Start the Bluetooth receive folder watcher in a background thread.

    Args:
        receive_folder: Folder to watch for incoming .edf files.
                        Defaults to the OS-appropriate BT receive folder.
        patient_id:     Default patient ID if not encoded in filename.

    Returns:
        True if started successfully.
    """
    global _watcher_thread, _default_patient_id

    if _watcher_thread and _watcher_thread.is_alive():
        log.warning("[BT] Watcher already running.")
        return False

    folder = receive_folder or _BT_RECEIVE_FOLDER
    _default_patient_id = patient_id

    os.makedirs(folder,   exist_ok=True)
    os.makedirs(_INCOMING, exist_ok=True)

    # Linux: start obexd if not already running
    if _OS == "Linux":
        _ensure_obexd(folder)

    _stop_event.clear()
    _set_status(state="watching", receive_folder=folder, error=None)

    _watcher_thread = threading.Thread(
        target=_watch_loop,
        args=(folder,),
        name="bt-receive-watcher",
        daemon=True,
    )
    _watcher_thread.start()
    log.info(f"[BT] Watching {folder} for incoming .edf files")
    return True


def stop_bt_watcher():
    """Stop the Bluetooth folder watcher."""
    _stop_event.set()
    if _watcher_thread and _watcher_thread.is_alive():
        _watcher_thread.join(timeout=5)
    _set_status(state="idle")
    log.info("[BT] Watcher stopped.")


def get_paired_devices() -> list[dict]:
    """
    Return a list of paired Bluetooth devices (Linux/Windows best-effort).
    """
    if _OS == "Linux":
        return _linux_list_devices()
    elif _OS == "Windows":
        return _windows_list_devices()
    else:
        return [{"note": "Device listing not supported on macOS — pair via System Preferences"}]


# ── Internal helpers ──────────────────────────────────────────────────────────

def _set_status(**kwargs):
    with _status_lock:
        _status.update(kwargs)


def _extract_patient_id(filename: str) -> str:
    """Extract patient ID from filename, same logic as watcher.py."""
    stem  = Path(filename).stem.upper()
    match = re.match(r"^(P\d+)", stem)
    if match:
        return match.group(1)
    match = re.search(r"\b(P\d{3,})\b", stem)
    if match:
        return match.group(1)
    return _default_patient_id


def _build_incoming_name(fname: str, patient_id: str) -> str:
    """
    Build the destination filename in data/incoming/.
    Adds patient prefix if not already present, matching watcher convention.
    """
    stem = Path(fname).stem.upper()
    if re.match(r"^P\d+", stem):
        return fname   # already has patient prefix
    return f"{patient_id}_{fname}"


def _move_to_incoming(src_path: str) -> str | None:
    """
    Move a received .edf file to data/incoming/ with correct naming.
    Returns the destination path, or None on failure.
    """
    fname      = os.path.basename(src_path)
    patient_id = _extract_patient_id(fname)
    dest_fname = _build_incoming_name(fname, patient_id)
    dest_path  = os.path.join(_INCOMING, dest_fname)

    # Avoid duplicate: append timestamp if name already exists
    if os.path.exists(dest_path):
        ts        = int(time.time())
        dest_fname = f"{ts}_{dest_fname}"
        dest_path  = os.path.join(_INCOMING, dest_fname)

    try:
        shutil.move(src_path, dest_path)
        log.info(f"[BT] Moved {fname} → {dest_path}")
        return dest_path
    except Exception as e:
        log.error(f"[BT] Failed to move {fname}: {e}")
        return None


def _is_file_stable(filepath: str, wait: float = 2.0, retries: int = 8) -> bool:
    """Wait until file size stops growing (transfer complete)."""
    prev = -1
    for _ in range(retries):
        try:
            size = os.path.getsize(filepath)
        except OSError:
            time.sleep(wait)
            continue
        if size == prev and size > 0:
            return True
        prev = size
        time.sleep(wait)
    return False


def _watch_loop(folder: str):
    """
    Poll the BT receive folder for new .edf files.
    Uses polling (not watchdog) so it has no extra dependencies.
    """
    log.info(f"[BT] Folder watch started: {folder}")
    seen = set()

    while not _stop_event.is_set():
        try:
            entries = os.listdir(folder)
        except FileNotFoundError:
            os.makedirs(folder, exist_ok=True)
            _stop_event.wait(2)
            continue
        except Exception as e:
            log.error(f"[BT] listdir error: {e}")
            _stop_event.wait(2)
            continue

        for fname in entries:
            if not fname.lower().endswith((".edf", ".edf+")):
                continue
            fpath = os.path.join(folder, fname)
            if fpath in seen:
                continue

            seen.add(fpath)
            log.info(f"[BT] Detected: {fname}")

            # Handle in background so watcher loop never blocks
            t = threading.Thread(
                target=_handle_received_file,
                args=(fpath, fname),
                daemon=True,
                name=f"bt-handle-{fname[:12]}",
            )
            t.start()

        _stop_event.wait(1.0)   # poll interval

    log.info("[BT] Watch loop exited.")


def _handle_received_file(fpath: str, fname: str):
    """Wait for stability, then move to incoming/ for watcher.py to ingest."""
    if not _is_file_stable(fpath):
        log.warning(f"[BT] File did not stabilise, skipping: {fname}")
        return

    dest = _move_to_incoming(fpath)
    if dest:
        with _status_lock:
            _status["files_received"] += 1
            _status["last_file"] = fname
        log.info(f"[BT] {fname} handed off to watcher pipeline")


# ── Linux: obexd (BlueZ) ──────────────────────────────────────────────────────

def _is_obexd_running() -> bool:
    """Check if obexd is running (Linux only)."""
    try:
        import subprocess
        r = subprocess.run(["pgrep", "-x", "obexd"], capture_output=True)
        return r.returncode == 0
    except Exception:
        return False


def _ensure_obexd(receive_folder: str):
    """
    Start obexd in OBEX Push server mode if not already running (Linux).
    obexd accepts incoming Bluetooth OBEX Push transfers and saves files
    to the configured receive folder.
    """
    if _is_obexd_running():
        log.info("[BT/Linux] obexd already running.")
        return

    try:
        import subprocess
        os.makedirs(receive_folder, exist_ok=True)
        # obexd --root sets the receive directory, --auto-accept skips prompts
        cmd = ["obexd", "--root", receive_folder, "--auto-accept", "--no-daemon"]
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        if _is_obexd_running():
            log.info(f"[BT/Linux] obexd started, receiving to {receive_folder}")
        else:
            log.warning("[BT/Linux] obexd may not have started. Install: sudo apt install bluez-obexd")
    except FileNotFoundError:
        log.warning("[BT/Linux] obexd not found. Install: sudo apt install bluez-obexd")
    except Exception as e:
        log.warning(f"[BT/Linux] Could not start obexd: {e}")


def _linux_list_devices() -> list[dict]:
    """List paired BT devices via bluetoothctl (Linux)."""
    try:
        import subprocess
        r = subprocess.run(
            ["bluetoothctl", "devices"],
            capture_output=True, text=True, timeout=5
        )
        devices = []
        for line in r.stdout.strip().splitlines():
            # Format: "Device AA:BB:CC:DD:EE:FF DeviceName"
            parts = line.strip().split(" ", 2)
            if len(parts) >= 3 and parts[0] == "Device":
                devices.append({"mac": parts[1], "name": parts[2]})
        return devices
    except Exception as e:
        return [{"error": str(e)}]


def _windows_list_devices() -> list[dict]:
    """List paired BT devices via PowerShell (Windows)."""
    try:
        import subprocess
        ps = (
            "Get-PnpDevice -Class Bluetooth | "
            "Where-Object Status -eq 'OK' | "
            "Select-Object FriendlyName, DeviceID | "
            "ConvertTo-Json"
        )
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps],
            capture_output=True, text=True, timeout=10
        )
        import json
        raw = json.loads(r.stdout or "[]")
        if isinstance(raw, dict):
            raw = [raw]
        return [{"name": d.get("FriendlyName", "?"), "id": d.get("DeviceID", "")} for d in raw]
    except Exception as e:
        return [{"error": str(e)}]


# ── Flask blueprint ───────────────────────────────────────────────────────────

def make_bt_blueprint():
    """
    Returns a Flask blueprint with Bluetooth status/control endpoints.
    Register in api.py:
        from acquisition.bt_receiver import make_bt_blueprint, start_bt_watcher
        app.register_blueprint(make_bt_blueprint())
        # In __main__: start_bt_watcher()
    """
    from flask import Blueprint, request, jsonify

    bt_bp = Blueprint("bt", __name__)

    @bt_bp.get("/api/bt/status")
    def api_bt_status():
        return jsonify(get_bt_status())

    @bt_bp.get("/api/bt/devices")
    def api_bt_devices():
        return jsonify(get_paired_devices())

    @bt_bp.post("/api/bt/start")
    def api_bt_start():
        data       = request.get_json(force=True, silent=True) or {}
        folder     = data.get("receive_folder")
        patient_id = data.get("patient_id", "UNKNOWN")
        ok = start_bt_watcher(receive_folder=folder, patient_id=patient_id)
        return jsonify({"ok": ok, "status": get_bt_status()})

    @bt_bp.post("/api/bt/stop")
    def api_bt_stop():
        stop_bt_watcher()
        return jsonify({"ok": True})

    return bt_bp


# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description="Bluetooth EDF receiver — Holter acquisition"
    )
    parser.add_argument("--folder",  default=None,      help="BT receive folder (auto-detect if omitted)")
    parser.add_argument("--patient", default="UNKNOWN", help="Default patient ID e.g. P001")
    parser.add_argument("--status",  action="store_true", help="Print status and exit")
    args = parser.parse_args()

    if args.status:
        import json
        print(json.dumps(get_bt_status(), indent=2))
        sys.exit(0)

    log.info(f"Bluetooth receiver — OS={_OS}  folder={args.folder or _BT_RECEIVE_FOLDER}")
    start_bt_watcher(receive_folder=args.folder, patient_id=args.patient)

    try:
        while True:
            time.sleep(5)
            s = get_bt_status()
            log.info(f"[BT] state={s['state']}  files_received={s['files_received']}")
    except KeyboardInterrupt:
        log.info("Stopping…")
    finally:
        stop_bt_watcher()
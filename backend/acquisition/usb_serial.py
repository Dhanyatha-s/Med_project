"""
usb_serial.py  —  USB serial (CDC) receiver for Holter EDF data
─────────────────────────────────────────────────────────────────────────────
Reads raw EDF bytes from a CDC serial port and feeds them into IngestSession.
Works identically on Windows, Linux, and macOS.

Architecture:
  Holter device (USB cable)
      │  CDC 460800 baud serial
      ▼
  usb_serial.py  ← this file
      │  session.feed(chunk)  [same API as wifi_receiver]
      ▼
  IngestSession  →  3-thread pipeline  →  HDF5 / Blosc
      ▼
  api.py  GET /api/transfer/status/<session_id>

Integration into api.py:
─────────────────────────────────────────────────────────────────────────────
  from acquisition.usb_serial import start_usb_listener, stop_usb_listener, \
                                      get_usb_status, list_ports

  # In __main__ block (after run_watcher):
  start_usb_listener()        # auto-detects Holter on reconnect

  # New routes to add:
  @app.get("/api/usb/status")
  def usb_status():
      return jsonify(get_usb_status())

  @app.get("/api/usb/ports")
  def usb_ports():
      return jsonify(list_ports())

  @app.post("/api/usb/connect")
  def usb_connect():
      port = request.json.get("port")
      patient_id = request.json.get("patient_id", "UNKNOWN")
      start_usb_listener(port=port, patient_id=patient_id)
      return jsonify({"ok": True})

  @app.post("/api/usb/disconnect")
  def usb_disconnect():
      stop_usb_listener()
      return jsonify({"ok": True})

Testing without hardware:
─────────────────────────────────────────────────────────────────────────────
  Linux/macOS (one-time setup):
      socat PTY,link=/tmp/ttyHOLTER_TX,rawer PTY,link=/tmp/ttyHOLTER_RX,rawer &

  Then run receiver (points to RX end):
      python -m acquisition.usb_serial --port /tmp/ttyHOLTER_RX --patient P001

  Then send EDF (points to TX end):
      python acquisition/simulate_device.py --mode usb \\
          --edf data/P001_test_300s.edf --port /tmp/ttyHOLTER_TX

  Windows (one-time setup — com0com):
      Install com0com → create pair COM10 <-> COM11

  Then run receiver on COM11:
      python -m acquisition.usb_serial --port COM11 --patient P001

  Then send on COM10:
      python acquisition/simulate_device.py --mode usb \\
          --edf data/P001_test_300s.edf --port COM10
"""

import os
import sys
import time
import logging
import argparse
import threading

log = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────
_DEFAULT_BAUD     = 460800          # CDC standard for most Holter devices
_CHUNK_SIZE       = 65536           # 64 KB — matches wifi_receiver and simulate_device
_RECONNECT_DELAY  = 3.0             # seconds between reconnect attempts
_HANDSHAKE_CMD    = b"REQUEST\r\n"  # optional: send to trigger device transmission
_HANDSHAKE_RESP   = b"OK"           # optional: device acknowledges before streaming
_IDLE_TIMEOUT     = 30.0            # seconds of silence before assuming transfer done

# ── Holter vendor/product IDs for auto-detection ──────────────────────────────
# Add your device's IDs here. "None" entries are wildcards.
_HOLTER_USB_IDS = [
    # (vid,  pid,   description)
    (0x0403, 0x6001, "FTDI FT232R — common Holter UART bridge"),
    (0x0403, 0x6015, "FTDI FT230X"),
    (0x10C4, 0xEA60, "CP210x — Silicon Labs UART bridge"),
    (0x1A86, 0x7523, "CH340 — common Chinese Holter boards"),
    (0x067B, 0x2303, "Prolific PL2303"),
    (None,   None,   "any CDC ACM device"),   # fallback wildcard
]

# ── Module state ──────────────────────────────────────────────────────────────
_listener_thread: threading.Thread | None = None
_stop_event       = threading.Event()
_status: dict     = {
    "state":       "idle",         # idle | connecting | receiving | complete | error
    "port":        None,
    "baud":        _DEFAULT_BAUD,
    "session_id":  None,
    "patient_id":  None,
    "bytes_total": 0,
    "bytes_recv":  0,
    "error":       None,
}
_status_lock = threading.Lock()


# ── Public API ────────────────────────────────────────────────────────────────

def list_ports() -> list[dict]:
    """
    Return all available serial ports with metadata.
    Marks likely Holter devices.
    """
    try:
        import serial.tools.list_ports as lp
    except ImportError:
        return [{"error": "pyserial not installed — run: pip install pyserial"}]

    ports = []
    for p in lp.comports():
        likely = _is_likely_holter(p)
        ports.append({
            "port":        p.device,
            "description": p.description or "Unknown",
            "hwid":        p.hwid or "",
            "vid":         p.vid,
            "pid":         p.pid,
            "likely_holter": likely,
        })
    return sorted(ports, key=lambda x: (not x["likely_holter"], x["port"]))


def get_usb_status() -> dict:
    """Return current USB listener state (thread-safe)."""
    with _status_lock:
        return dict(_status)


def start_usb_listener(
    port:       str   = None,
    patient_id: str   = "UNKNOWN",
    baud:       int   = _DEFAULT_BAUD,
    auto_detect: bool = True,
) -> bool:
    """
    Start the USB serial listener in a background thread.

    Args:
        port:        Serial port path. If None and auto_detect=True,
                     scans for a likely Holter device automatically.
        patient_id:  Patient ID to use for the IngestSession.
        baud:        Serial baud rate (default 460800).
        auto_detect: If port is None, try to auto-detect the Holter device.

    Returns:
        True if started, False if already running or pyserial not installed.
    """
    global _listener_thread

    if _listener_thread and _listener_thread.is_alive():
        log.warning("[USB] Listener already running. Call stop_usb_listener() first.")
        return False

    try:
        import serial  # noqa: F401 — early import check
    except ImportError:
        log.error("[USB] pyserial not installed. Run: pip install pyserial")
        _set_status(state="error", error="pyserial not installed")
        return False

    _stop_event.clear()
    _set_status(state="connecting", port=port, baud=baud, patient_id=patient_id)

    _listener_thread = threading.Thread(
        target=_listener_loop,
        args=(port, patient_id, baud, auto_detect),
        name="usb-serial-listener",
        daemon=True,
    )
    _listener_thread.start()
    log.info(f"[USB] Listener started — port={port or 'auto'} baud={baud} patient={patient_id}")
    return True


def stop_usb_listener():
    """Stop the USB listener gracefully."""
    _stop_event.set()
    if _listener_thread and _listener_thread.is_alive():
        _listener_thread.join(timeout=5)
    _set_status(state="idle")
    log.info("[USB] Listener stopped.")


# ── Internal helpers ──────────────────────────────────────────────────────────

def _set_status(**kwargs):
    with _status_lock:
        _status.update(kwargs)


def _is_likely_holter(port_info) -> bool:
    """Return True if this port's VID/PID matches a known Holter USB bridge."""
    try:
        import serial.tools.list_ports as lp  # noqa: F401
    except ImportError:
        return False
    for vid, pid, _ in _HOLTER_USB_IDS:
        if vid is None:
            return True   # wildcard
        if port_info.vid == vid and (pid is None or port_info.pid == pid):
            return True
    return False


def _auto_detect_port() -> str | None:
    """Scan ports and return the first likely Holter device."""
    ports = list_ports()
    for p in ports:
        if p.get("likely_holter") and "port" in p:
            log.info(f"[USB] Auto-detected: {p['port']}  {p['description']}")
            return p["port"]
    return None


def _listener_loop(
    port:        str   | None,
    patient_id:  str,
    baud:        int,
    auto_detect: bool,
):
    """
    Main loop: detect port → open serial → handshake → feed IngestSession.
    Reconnects automatically if connection drops.
    """
    import serial

    while not _stop_event.is_set():
        # ── Port resolution ───────────────────────────────────────────────────
        active_port = port
        if not active_port and auto_detect:
            active_port = _auto_detect_port()
            if not active_port:
                log.debug("[USB] No Holter device found, retrying in 3s…")
                _stop_event.wait(_RECONNECT_DELAY)
                continue

        # ── Open serial port ──────────────────────────────────────────────────
        _set_status(state="connecting", port=active_port)
        try:
            ser = serial.Serial(
                port=active_port,
                baudrate=baud,
                timeout=_IDLE_TIMEOUT,   # readline/read block max this long
                write_timeout=5,
            )
            log.info(f"[USB] Opened {active_port} @ {baud} baud")
        except serial.SerialException as e:
            log.warning(f"[USB] Cannot open {active_port}: {e} — retry in {_RECONNECT_DELAY}s")
            _set_status(state="error", error=str(e))
            _stop_event.wait(_RECONNECT_DELAY)
            continue

        # ── Optional handshake ────────────────────────────────────────────────
        try:
            ser.write(_HANDSHAKE_CMD)
            resp = ser.read(len(_HANDSHAKE_RESP))
            if resp and resp != _HANDSHAKE_RESP:
                log.debug(f"[USB] Handshake response: {resp!r} (continuing anyway)")
        except Exception:
            pass   # handshake is best-effort; some devices auto-stream

        # ── Start IngestSession ───────────────────────────────────────────────
        from acquisition.ingest_stream import IngestSession
        session = IngestSession(
            patient_id    = patient_id,
            source_path   = None,          # we feed() manually, like WiFi
            bytes_total   = 0,             # unknown until first EDF header
            source_method = "usb",
        )
        _set_status(
            state="receiving",
            session_id=session.session_id,
            bytes_recv=0,
            bytes_total=0,
            error=None,
        )
        log.info(f"[USB] IngestSession {session.session_id[:8]} started")

        # ── Stream read loop ──────────────────────────────────────────────────
        bytes_recv = 0
        last_data  = time.monotonic()

        try:
            while not _stop_event.is_set():
                chunk = ser.read(_CHUNK_SIZE)
                if not chunk:
                    # Timeout or empty read — check idle
                    idle = time.monotonic() - last_data
                    if bytes_recv > 0 and idle >= _IDLE_TIMEOUT:
                        log.info(f"[USB] No data for {idle:.0f}s — assuming transfer complete")
                        break
                    continue

                session.feed(chunk)
                bytes_recv += len(chunk)
                last_data   = time.monotonic()
                _set_status(bytes_recv=bytes_recv)

                if bytes_recv % (1024 * 1024) < _CHUNK_SIZE:
                    log.info(f"[USB] Received {bytes_recv/1e6:.1f} MB")

        except serial.SerialException as e:
            log.error(f"[USB] Serial error after {bytes_recv/1e6:.1f} MB: {e}")
            session.cancel()
            _set_status(state="error", error=str(e))
        except Exception as e:
            log.error(f"[USB] Unexpected error: {e}")
            session.cancel()
            _set_status(state="error", error=str(e))
        finally:
            try:
                ser.close()
            except Exception:
                pass

        # Signal EDF parser that all bytes have arrived (same as wifi_receiver)
        if bytes_recv > 0:
            try:
                session._parser.set_total_bytes(bytes_recv)
                session._parser.feed_complete()
                log.info(f"[USB] Stream complete — {bytes_recv/1e6:.1f} MB  session={session.session_id[:8]}")
                _set_status(state="complete")
            except Exception as e:
                log.error(f"[USB] feed_complete error: {e}")
                _set_status(state="error", error=str(e))

        # If port was auto-detected, loop back to wait for next insertion
        if not port and auto_detect and not _stop_event.is_set():
            log.info("[USB] Waiting for next device insertion…")
            _set_status(state="connecting", session_id=None)
            _stop_event.wait(_RECONNECT_DELAY)
        else:
            break   # explicit port — stop after one transfer


# ── Flask blueprint (optional wiring into api.py) ────────────────────────────

def make_usb_blueprint():
    """
    Returns a Flask blueprint with USB status/control endpoints.
    Register in api.py:
        from acquisition.usb_serial import make_usb_blueprint
        app.register_blueprint(make_usb_blueprint())
    """
    from flask import Blueprint, request, jsonify, abort

    usb_bp = Blueprint("usb", __name__)

    @usb_bp.get("/api/usb/ports")
    def api_list_ports():
        return jsonify(list_ports())

    @usb_bp.get("/api/usb/status")
    def api_usb_status():
        return jsonify(get_usb_status())

    @usb_bp.post("/api/usb/connect")
    def api_usb_connect():
        data       = request.get_json(force=True, silent=True) or {}
        port       = data.get("port")           # None → auto-detect
        patient_id = data.get("patient_id", "UNKNOWN")
        baud       = int(data.get("baud", _DEFAULT_BAUD))
        ok = start_usb_listener(port=port, patient_id=patient_id, baud=baud)
        return jsonify({"ok": ok, "port": port or "auto"})

    @usb_bp.post("/api/usb/disconnect")
    def api_usb_disconnect():
        stop_usb_listener()
        return jsonify({"ok": True})

    return usb_bp


# ── CLI entry point ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    parser = argparse.ArgumentParser(
        description="USB serial EDF receiver — Holter acquisition"
    )
    parser.add_argument("--port",       default=None,         help="Serial port (auto-detect if omitted)")
    parser.add_argument("--baud",       type=int, default=_DEFAULT_BAUD, help="Baud rate (default 460800)")
    parser.add_argument("--patient",    default="UNKNOWN",    help="Patient ID e.g. P001")
    parser.add_argument("--list-ports", action="store_true",  help="List available serial ports and exit")
    args = parser.parse_args()

    if args.list_ports:
        ports = list_ports()
        if not ports:
            print("No serial ports found.")
        for p in ports:
            marker = " ← likely Holter" if p.get("likely_holter") else ""
            print(f"  {p.get('port', '?'):15}  {p.get('description', '')}{marker}")
        sys.exit(0)

    log.info(f"USB serial receiver — port={args.port or 'auto-detect'}  baud={args.baud}  patient={args.patient}")
    start_usb_listener(port=args.port, patient_id=args.patient, baud=args.baud)

    try:
        while True:
            time.sleep(1)
            s = get_usb_status()
            if s["state"] == "complete":
                log.info("Transfer complete. Exiting.")
                break
    except KeyboardInterrupt:
        log.info("Stopping…")
    finally:
        stop_usb_listener()
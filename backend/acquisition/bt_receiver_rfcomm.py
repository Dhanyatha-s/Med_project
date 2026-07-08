"""
bt_receiver_rfcomm.py — RFCOMM server companion for bt_sender.py
─────────────────────────────────────────────────────────────────────────────
Listens on an RFCOMM Bluetooth channel for incoming connections from
bt_sender.py (the other laptop). Reads the JSON header (patient_id,
patient_name, age, sex, filename, filesize) followed by the raw EDF bytes,
writes the EDF into data/incoming/ with the patient-prefixed filename so
watcher.py's existing pipeline picks it up automatically, and writes a
sidecar <name>.meta.json with the patient demographics for api.py to read.

This runs ALONGSIDE bt_receiver.py (OBEX-based). Use whichever transport
matches your sender:
  - bt_sender.py (this protocol)        → bt_receiver_rfcomm.py
  - Phone "Share via Bluetooth" (OBEX)   → bt_receiver.py

─────────────────────────────────────────────────────────────────────────────
SETUP (receiving laptop — Linux/BlueZ):
  pip install pybluez2
  sudo systemctl restart bluetooth
  # Make adapter discoverable & pairable:
  bluetoothctl
    power on
    discoverable on
    pairable on
    agent on

  Get this laptop's MAC (sender needs it):
    hciconfig   # or: bluetoothctl show

RUN:
  python -m acquisition.bt_receiver_rfcomm --patient P001
  (patient_id arg is just a fallback default if the sender's header
   doesn't include one)

Integration into api.py — same pattern as bt_receiver.py:
  from acquisition.bt_receiver_rfcomm import start_rfcomm_server, stop_rfcomm_server
  start_rfcomm_server()   # in __main__ after run_watcher()
"""

import os
import json
import struct
import logging
import threading
import argparse

log = logging.getLogger(__name__)

_DATA_DIR = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "data"))
_INCOMING = os.path.join(_DATA_DIR, "incoming")

_DEFAULT_CHANNEL = 22
_CHUNK_SIZE      = 65536

_server_thread: threading.Thread | None = None
_stop_event     = threading.Event()
_status_lock    = threading.Lock()
_status = {
    "state":          "idle",     # idle | listening | error
    "channel":        _DEFAULT_CHANNEL,
    "files_received": 0,
    "last_file":      None,
    "last_patient":   None,
    "error":          None,
}


def get_status() -> dict:
    with _status_lock:
        return dict(_status)


def _set_status(**kwargs):
    with _status_lock:
        _status.update(kwargs)


def start_rfcomm_server(channel: int = _DEFAULT_CHANNEL) -> bool:
    """Start the RFCOMM listener in a background thread."""
    global _server_thread

    if _server_thread and _server_thread.is_alive():
        log.warning("[BT-RFCOMM] Server already running.")
        return False

    os.makedirs(_INCOMING, exist_ok=True)
    _stop_event.clear()
    _set_status(state="listening", channel=channel, error=None)

    _server_thread = threading.Thread(
        target=_serve_loop,
        args=(channel,),
        name="bt-rfcomm-server",
        daemon=True,
    )
    _server_thread.start()
    log.info(f"[BT-RFCOMM] Listening on RFCOMM channel {channel}")
    return True


def stop_rfcomm_server():
    _stop_event.set()
    if _server_thread and _server_thread.is_alive():
        _server_thread.join(timeout=5)
    _set_status(state="idle")
    log.info("[BT-RFCOMM] Server stopped.")


# ── Internal ────────────────────────────────────────────────────────────────

def _serve_loop(channel: int):
    try:
        import bluetooth
    except ImportError:
        log.error("[BT-RFCOMM] pybluez not installed. pip install pybluez2")
        _set_status(state="error", error="pybluez not installed")
        return

    try:
        server_sock = bluetooth.BluetoothSocket(bluetooth.RFCOMM)
        server_sock.bind(("", channel))
        server_sock.listen(1)

        # Advertise via SDP so the sender can discover us (optional but helpful)
        try:
            bluetooth.advertise_service(
                server_sock,
                "HolterEDFReceiver",
                service_id="00001101-0000-1000-8000-00805F9B34FB",
                service_classes=[
                    "00001101-0000-1000-8000-00805F9B34FB",
                    bluetooth.SERIAL_PORT_CLASS,
                ],
                profiles=[bluetooth.SERIAL_PORT_PROFILE],
            )
        except Exception as e:
            log.warning(f"[BT-RFCOMM] SDP advertise failed (non-fatal): {e}")

        server_sock.settimeout(1.0)
    except Exception as e:
        log.error(f"[BT-RFCOMM] Failed to bind/listen: {e}")
        _set_status(state="error", error=str(e))
        return

    log.info(f"[BT-RFCOMM] Ready on channel {channel}")

    while not _stop_event.is_set():
        try:
            client_sock, client_info = server_sock.accept()
        except bluetooth.BluetoothError:
            continue   # timeout, loop and check _stop_event
        except Exception as e:
            log.error(f"[BT-RFCOMM] accept() error: {e}")
            continue

        log.info(f"[BT-RFCOMM] Connection from {client_info}")
        t = threading.Thread(
            target=_handle_client,
            args=(client_sock,),
            daemon=True,
            name="bt-rfcomm-client",
        )
        t.start()

    try:
        server_sock.close()
    except Exception:
        pass
    log.info("[BT-RFCOMM] Server loop exited.")


def _recv_exact(sock, n: int) -> bytes:
    """Receive exactly n bytes from a bluetooth socket."""
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("Socket closed before expected bytes received")
        buf += chunk
    return buf


def _handle_client(client_sock):
    try:
        # 1. Read 4-byte header length, then header JSON
        header_len = struct.unpack(">I", _recv_exact(client_sock, 4))[0]
        header_raw = _recv_exact(client_sock, header_len)
        header = json.loads(header_raw.decode("utf-8"))

        patient_id   = str(header.get("patient_id", "UNKNOWN")).upper()
        patient_name = header.get("patient_name", "Unknown")
        age          = header.get("age")
        sex          = header.get("sex")
        fname        = header.get("filename", f"{patient_id}_received.edf")
        filesize     = int(header.get("filesize", 0))

        log.info(
            f"[BT-RFCOMM] Header: patient_id={patient_id} name={patient_name} "
            f"age={age} sex={sex} file={fname} size={filesize/1e6:.1f}MB"
        )

        # Ensure filename carries the patient prefix (watcher convention)
        if not fname.upper().startswith(patient_id):
            fname = f"{patient_id}_{fname}"

        dest_edf  = os.path.join(_INCOMING, fname)
        dest_meta = os.path.splitext(dest_edf)[0] + ".meta.json"

        # 2. Stream the EDF bytes to disk
        received = 0
        with open(dest_edf, "wb") as out:
            while received < filesize:
                to_read = min(_CHUNK_SIZE, filesize - received)
                chunk = client_sock.recv(to_read)
                if not chunk:
                    break
                out.write(chunk)
                received += len(chunk)

        if received < filesize:
            log.warning(
                f"[BT-RFCOMM] Incomplete transfer: {received}/{filesize} bytes "
                f"for {fname}"
            )

        # 3. Write sidecar metadata for api.py to pick up
        meta = {
            "patient_id":   patient_id,
            "patient_name": patient_name,
            "age":          age,
            "sex":          sex,
            "source_method": "bt",
            "received_bytes": received,
            "expected_bytes": filesize,
        }
        with open(dest_meta, "w") as f:
            json.dump(meta, f, indent=2)

        with _status_lock:
            _status["files_received"] += 1
            _status["last_file"]    = fname
            _status["last_patient"] = patient_id

        log.info(f"[BT-RFCOMM] Saved {fname} ({received/1e6:.1f}MB) → {dest_edf}")
        log.info(f"[BT-RFCOMM] Metadata → {dest_meta}")
        log.info("[BT-RFCOMM] watcher.py will pick up the EDF automatically")

    except Exception as e:
        log.error(f"[BT-RFCOMM] Client handling error: {e}")
        _set_status(error=str(e))
    finally:
        try:
            client_sock.close()
        except Exception:
            pass


# ── CLI ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )

    ap = argparse.ArgumentParser(description="RFCOMM Bluetooth EDF receiver")
    ap.add_argument("--channel", type=int, default=_DEFAULT_CHANNEL, help="RFCOMM channel")
    args = ap.parse_args()

    start_rfcomm_server(channel=args.channel)

    try:
        import time
        while True:
            time.sleep(5)
            s = get_status()
            log.info(f"[BT-RFCOMM] state={s['state']} files_received={s['files_received']}")
    except KeyboardInterrupt:
        log.info("Stopping...")
    finally:
        stop_rfcomm_server()
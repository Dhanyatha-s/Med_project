"""
discovery.py  —  LAN auto-discovery responder for the Holter ECG API
─────────────────────────────────────────────────────────────────────────────
Lets the phone simulator (or a real Holter device) find this server's IP
automatically, instead of the user typing --server http://<ip>:5000.

Protocol (deliberately tiny, stdlib-only, no zeroconf/avahi dependency):

  Phone  → UDP broadcast "HOLTER_DISCOVER" to <broadcast>:5005
  Server → UDP unicast reply (JSON) to the phone's address:
             {"service": "holter_ecg_api", "ip": "<lan ip>",
              "port": 5000, "hostname": "<pc hostname>"}

The phone then builds http://<ip>:<port> and proceeds exactly as if
--server had been passed manually.

Integration into api.py:
─────────────────────────────────────────────────────────────────────────────
  from acquisition.discovery import start_discovery_responder, stop_discovery_responder

  # In __main__, alongside run_watcher() / start_bt_watcher():
  start_discovery_responder(PORT)
"""

import os
import json
import socket
import logging
import threading

log = logging.getLogger(__name__)

DISCOVERY_PORT = 5005
SERVICE_NAME   = "holter_ecg_api"

_thread      = None
_stop_event  = threading.Event()


def _get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def _responder_loop(api_port: int):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind(("0.0.0.0", DISCOVERY_PORT))
    except OSError as e:
        log.error(f"[Discovery] Cannot bind UDP :{DISCOVERY_PORT} — {e}")
        return

    sock.settimeout(1.0)
    log.info(f"[Discovery] Listening for broadcasts on UDP :{DISCOVERY_PORT}")

    while not _stop_event.is_set():
        try:
            data, addr = sock.recvfrom(1024)
        except socket.timeout:
            continue
        except Exception as e:
            log.warning(f"[Discovery] recv error: {e}")
            continue

        if data.strip() != b"HOLTER_DISCOVER":
            continue

        reply = json.dumps({
            "service":  SERVICE_NAME,
            "ip":       _get_lan_ip(),
            "port":     api_port,
            "hostname": socket.gethostname(),
        }).encode("utf-8")

        try:
            sock.sendto(reply, addr)
            log.info(f"[Discovery] Replied to {addr[0]}:{addr[1]}")
        except Exception as e:
            log.warning(f"[Discovery] send error: {e}")

    sock.close()
    log.info("[Discovery] Responder stopped")


def start_discovery_responder(api_port: int = 5000) -> bool:
    """Start the UDP discovery responder in a background thread."""
    global _thread
    if _thread and _thread.is_alive():
        log.warning("[Discovery] Already running.")
        return False
    _stop_event.clear()
    _thread = threading.Thread(
        target=_responder_loop,
        args=(api_port,),
        daemon=True,
        name="discovery-responder",
    )
    _thread.start()
    return True


def stop_discovery_responder():
    _stop_event.set()
    if _thread and _thread.is_alive():
        _thread.join(timeout=2)
    log.info("[Discovery] Stopped.")


# ── CLI test ──────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    import time
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(message)s")
    start_discovery_responder(int(os.environ.get("PORT", 5000)))
    try:
        while True:
            time.sleep(5)
    except KeyboardInterrupt:
        stop_discovery_responder()
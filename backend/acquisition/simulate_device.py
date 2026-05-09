"""
simulate_device.py  —  Holter device simulator for testing
─────────────────────────────────────────────────────────────────────────────
Simulates a real Holter monitor transferring data over each method.
Use this to test the full pipeline without hardware.

Usage:
  python simulate_device.py --mode sd     --edf data/test.edf --patient P001
  python simulate_device.py --mode wifi   --edf data/test.edf --patient P001 --speed 6
  python simulate_device.py --mode usb    --edf data/test.edf --port COM10
  python simulate_device.py --mode bt     --edf data/test.edf
  python simulate_device.py --generate    --patient P001 --duration 300
"""

import os, sys, time, argparse, shutil, threading, logging
import requests

log = logging.getLogger(__name__)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%H:%M:%S",
)

_DATA_DIR    = os.path.normpath(os.path.join(os.path.dirname(__file__), "data"))
_INCOMING    = os.path.join(_DATA_DIR, "incoming")
_CHUNK_SIZE  = 65536   # 64 KB


# ── Progress bar ──────────────────────────────────────────────────────────────

def _progress(done, total, label=""):
    pct  = done / total * 100 if total > 0 else 0
    bar  = "█" * int(pct / 2) + "░" * (50 - int(pct / 2))
    mb_d = done  / 1e6
    mb_t = total / 1e6
    sys.stdout.write(f"\r  {label} [{bar}] {pct:5.1f}%  {mb_d:.1f}/{mb_t:.1f} MB")
    sys.stdout.flush()


# ── Mode 1: SD card ───────────────────────────────────────────────────────────

def simulate_sd(edf_path: str, patient_id: str):
    """
    Copies the EDF file directly into data/incoming/.
    Watcher.py detects it and triggers ingest.
    """
    os.makedirs(_INCOMING, exist_ok=True)
    fname  = f"{patient_id}_{os.path.basename(edf_path)}"
    dest   = os.path.join(_INCOMING, fname)
    size   = os.path.getsize(edf_path)

    print(f"\n[SD] Simulating SD card file copy")
    print(f"     Source : {edf_path}  ({size/1e6:.1f} MB)")
    print(f"     Dest   : {dest}")

    t0 = time.time()
    shutil.copy2(edf_path, dest)
    elapsed = time.time() - t0

    print(f"\n[SD] Copy complete in {elapsed:.1f}s  ({size/1e6/elapsed:.1f} MB/s)")
    print(f"[SD] watcher.py will detect this file automatically")
    print(f"[SD] Poll http://localhost:5000/api/transfer/status to track progress")


# ── Mode 2: WiFi ──────────────────────────────────────────────────────────────

def simulate_wifi(
    edf_path:   str,
    patient_id: str,
    speed_mbs:  float = 6.0,
    server_url: str   = "http://localhost:5000",
):
    """
    Streams EDF to /upload endpoint in 64KB chunks.
    Throttles to speed_mbs to simulate real WiFi speed.
    Polls /api/transfer/status to show ECG availability.
    """
    size        = os.path.getsize(edf_path)
    fname       = os.path.basename(edf_path)
    delay       = _CHUNK_SIZE / (speed_mbs * 1e6)   # seconds per chunk
    upload_url  = f"{server_url}/upload"

    print(f"\n[WiFi] Simulating WiFi transfer at {speed_mbs} MB/s")
    print(f"       File  : {edf_path}  ({size/1e6:.1f} MB)")
    print(f"       Server: {upload_url}")
    print(f"       ETA   : ~{size / (speed_mbs*1e6):.0f}s\n")

    sent       = 0
    session_id = None
    t0         = time.time()

    def gen():
        nonlocal sent
        with open(edf_path, "rb") as f:
            while True:
                chunk = f.read(_CHUNK_SIZE)
                if not chunk:
                    break
                if delay > 0:
                    time.sleep(delay)
                sent += len(chunk)
                _progress(sent, size, "WiFi")
                yield chunk

    try:
        resp = requests.post(
            upload_url,
            data=gen(),
            headers={
                "Content-Type":   "application/octet-stream",
                "Content-Length": str(size),
                "X-Patient-Id":   patient_id,
                "X-Filename":     fname,
            },
            stream=False,
            timeout=3600,
        )
        print()   # newline after progress bar
        data = resp.json()
        session_id = data.get("session_id")
        print(f"[WiFi] Upload response: {resp.status_code}  session={session_id}")
    except Exception as e:
        print(f"\n[WiFi] Upload failed: {e}")
        return

    elapsed = time.time() - t0
    print(f"[WiFi] Transfer complete in {elapsed:.1f}s  ({size/1e6/elapsed:.1f} MB/s)")

    if session_id:
        _poll_status(session_id, server_url)


# ── Mode 3: USB serial ────────────────────────────────────────────────────────

def simulate_usb(edf_path: str, send_port: str, baud: int = 460800):
    """
    Sends EDF over a virtual serial port pair.
    Requires com0com (Windows) or socat (Linux/Mac) to create the pair.

    Windows setup:
      1. Install com0com from https://sourceforge.net/projects/com0com/
      2. Create pair: COM10 <-> COM11
      3. Run: python simulate_device.py --mode usb --edf data/test.edf --port COM10
      4. In api.py startup, start a USB serial reader on COM11

    Linux/Mac setup:
      socat PTY,link=/tmp/ttyS10,rawer PTY,link=/tmp/ttyS11,rawer &
      python simulate_device.py --mode usb --edf data/test.edf --port /tmp/ttyS10
    """
    try:
        import serial
    except ImportError:
        print("[USB] pyserial not installed: pip install pyserial")
        return

    size = os.path.getsize(edf_path)
    print(f"\n[USB] Simulating USB serial transfer")
    print(f"      Port : {send_port}  Baud: {baud}")
    print(f"      File : {edf_path}  ({size/1e6:.1f} MB)")
    print(f"      NOTE : Receiver must be reading from the other port of the pair\n")

    sent = 0
    t0   = time.time()

    try:
        with serial.Serial(send_port, baud, timeout=10) as s:
            with open(edf_path, "rb") as f:
                while True:
                    chunk = f.read(_CHUNK_SIZE)
                    if not chunk:
                        break
                    s.write(chunk)
                    sent += len(chunk)
                    _progress(sent, size, "USB ")
        print()
        elapsed = time.time() - t0
        print(f"[USB] Done in {elapsed:.1f}s  ({size/1e6/elapsed:.1f} MB/s)")
    except Exception as e:
        print(f"\n[USB] Error: {e}")


# ── Mode 4: Bluetooth ─────────────────────────────────────────────────────────

def simulate_bt(edf_path: str):
    """
    For Bluetooth testing, use your Android phone or another laptop.

    Automated path (copies to a staging folder for manual BT send):
      This function places the EDF in data/bt_staging/ and prints instructions.

    Manual test with Android phone:
      1. Copy data/test_holter.edf to your phone (USB or ADB)
         adb push data/test_holter.edf /sdcard/test_holter.edf
      2. On phone: Files app → long-press test_holter.edf → Share → Bluetooth
      3. Select your laptop in the BT device list
      4. Accept file on laptop
      5. Move received file to data/incoming/
         (or configure BT receive folder to point there — see instructions below)

    Configure Windows BT receive folder:
      Settings → Bluetooth → Send or receive files via Bluetooth
      → Receive files → note the folder shown (usually Documents\\Bluetooth Exchange)
      Add watcher.py to watch that folder too by editing watcher.py _INCOMING_DIR
    """
    bt_staging = os.path.join(_DATA_DIR, "bt_staging")
    os.makedirs(bt_staging, exist_ok=True)
    dest = os.path.join(bt_staging, os.path.basename(edf_path))
    shutil.copy2(edf_path, dest)

    print(f"\n[BT] Bluetooth test instructions:")
    print(f"     File staged at: {dest}")
    print(f"")
    print(f"     Option A — Android phone:")
    print(f"       1. adb push {dest} /sdcard/{os.path.basename(edf_path)}")
    print(f"       2. Phone: Files → long-press → Share → Bluetooth → select laptop")
    print(f"       3. Accept on laptop, move received file to:")
    print(f"          {_INCOMING}")
    print(f"")
    print(f"     Option B — Another laptop on same network:")
    print(f"       bluetooth-sendto --device=<MAC> {dest}")
    print(f"")
    print(f"     Once file lands in {_INCOMING}")
    print(f"     watcher.py picks it up automatically.")


# ── Status poller ─────────────────────────────────────────────────────────────

def _poll_status(session_id: str, server_url: str, interval: float = 2.0):
    """Poll transfer status and print live updates until complete."""
    url = f"{server_url}/api/transfer/status/{session_id}"
    print(f"\n[Status] Polling {url}")
    print(f"         (ECG viewer at http://localhost:3000 should show waveform soon)\n")

    while True:
        try:
            r = requests.get(url, timeout=5)
            if r.status_code == 404:
                print(f"[Status] Session not found yet...")
                time.sleep(interval)
                continue
            d = r.json()
            status  = d.get("status", "?")
            pct_r   = d.get("pct_received",  0)
            pct_w   = d.get("pct_written",   0)
            secs    = d.get("seconds_available", 0)
            leads   = d.get("lead_names", [])
            err     = d.get("error_message", "")

            _progress(pct_w, 100, "Written")
            sys.stdout.write(
                f"  | ECG: {secs/60:.1f}min available"
                f"  leads={leads}"
                f"  status={status}"
            )
            sys.stdout.flush()

            if status == "complete":
                print(f"\n[Status] ✓ Complete. Full recording available.")
                break
            elif status == "error":
                print(f"\n[Status] ✗ Error: {err}")
                break

        except requests.ConnectionError:
            print(f"[Status] Cannot reach {server_url} — is api.py running?")
        except Exception as e:
            print(f"[Status] Poll error: {e}")

        time.sleep(interval)


# ── EDF generator (no real device needed) ────────────────────────────────────

def generate_test_edf(patient_id: str, duration_sec: int = 300, sr: int = 250):
    """
    Generate a synthetic EDF from your existing H5 data.
    If no H5 exists, generates fresh NeuroKit2 data.
    """
    out_path = os.path.join(_DATA_DIR, f"{patient_id}_test_{duration_sec}s.edf")

    # Try to use existing H5 first
    h5_candidates = [
        os.path.join(_DATA_DIR, "ecg_48hr_3leads_converted.h5"),
        os.path.join(_DATA_DIR, "ecg_48hr_12leads_converted.h5"),
        os.path.join(_DATA_DIR, "patients", patient_id, "ecg.h5"),
    ]
    h5_path = next((p for p in h5_candidates if os.path.exists(p)), None)

    if h5_path:
        print(f"[Generate] Converting existing H5 → EDF: {h5_path}")
        _h5_to_edf(h5_path, out_path, patient_id, duration_sec)
    else:
        print(f"[Generate] No H5 found — generating fresh NeuroKit2 data")
        _neurokit_to_edf(out_path, patient_id, duration_sec, sr)

    size = os.path.getsize(out_path)
    print(f"[Generate] Done: {out_path}  ({size/1e6:.1f} MB)")
    return out_path


def _h5_to_edf(h5_path, out_path, patient_id, duration_sec):
    import h5py, pyedflib, hdf5plugin, json
    import numpy as np

    with h5py.File(h5_path, "r") as f:
        sr        = int(f.attrs.get("sampling_rate", 250))
        n_samples = min(int(duration_sec * sr), f["ecg"].shape[0])
        data      = f["ecg"][:n_samples, :]
        try:
            lead_names = json.loads(f.attrs.get("lead_names", '["I","II","V2"]'))
        except Exception:
            lead_names = [f"Ch{i+1}" for i in range(data.shape[1])]

    n_leads = data.shape[1]
    writer  = pyedflib.EdfWriter(out_path, n_leads, file_type=pyedflib.FILETYPE_EDFPLUS)
    writer.setPatientCode(patient_id)
    writer.setPatientName(f"Test Patient {patient_id}")

    hdrs = [{
        "label":            lead_names[i] if i < len(lead_names) else f"Ch{i+1}",
        "dimension":        "mV",
        "sample_frequency": sr,
        "physical_max":     5.0,
        "physical_min":    -5.0,
        "digital_max":      32767,
        "digital_min":     -32768,
        "prefilter":        "HP:0.5Hz LP:45Hz N:50Hz",
        "transducer":       "AgAgCl electrode",
    } for i in range(n_leads)]

    writer.setSignalHeaders(hdrs)
    writer.writeSamples([data[:, i] for i in range(n_leads)])
    writer.close()


def _neurokit_to_edf(out_path, patient_id, duration_sec, sr):
    try:
        import neurokit2 as nk
        import pyedflib
        import numpy as np
    except ImportError as e:
        print(f"[Generate] Missing library: {e}")
        print("           pip install neurokit2 pyedflib")
        return

    n_leads = 3
    signals = [
        nk.ecg_simulate(duration=duration_sec, sampling_rate=sr, heart_rate=72, noise=0.05),
        nk.ecg_simulate(duration=duration_sec, sampling_rate=sr, heart_rate=72, noise=0.08),
        nk.ecg_simulate(duration=duration_sec, sampling_rate=sr, heart_rate=72, noise=0.06),
    ]
    lead_names = ["I", "II", "V2"]

    writer = pyedflib.EdfWriter(out_path, n_leads, file_type=pyedflib.FILETYPE_EDFPLUS)
    writer.setPatientCode(patient_id)
    writer.setPatientName(f"Test Patient {patient_id}")
    hdrs = [{
        "label": lead_names[i], "dimension": "mV",
        "sample_frequency": sr, "physical_max": 2.0, "physical_min": -2.0,
        "digital_max": 32767, "digital_min": -32768,
        "prefilter": "HP:0.5Hz LP:45Hz", "transducer": "Synthetic",
    } for i in range(n_leads)]
    writer.setSignalHeaders(hdrs)
    writer.writeSamples(signals)
    writer.close()


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Holter device simulator")
    parser.add_argument("--mode",     choices=["sd","wifi","usb","bt"], help="Transfer method")
    parser.add_argument("--edf",      help="Path to .edf file")
    parser.add_argument("--patient",  default="P001", help="Patient ID (default P001)")
    parser.add_argument("--speed",    type=float, default=6.0, help="WiFi speed MB/s (default 6)")
    parser.add_argument("--port",     default="COM10", help="Serial port for USB mode")
    parser.add_argument("--baud",     type=int, default=460800)
    parser.add_argument("--server",   default="http://localhost:5000")
    parser.add_argument("--generate", action="store_true", help="Generate test EDF first")
    parser.add_argument("--duration", type=int, default=300, help="Duration in seconds for --generate")
    args = parser.parse_args()

    # Generate test EDF if requested or no file given
    if args.generate or not args.edf:
        edf = generate_test_edf(args.patient, args.duration)
        if not args.mode:
            print(f"\nGenerated: {edf}")
            print("Run again with --mode sd/wifi/usb/bt to transfer it.")
            sys.exit(0)
        args.edf = edf

    if not args.edf or not os.path.exists(args.edf):
        print(f"Error: EDF file not found: {args.edf}")
        print("Use --generate to create a test EDF first.")
        sys.exit(1)

    if   args.mode == "sd":   simulate_sd(args.edf, args.patient)
    elif args.mode == "wifi": simulate_wifi(args.edf, args.patient, args.speed, args.server)
    elif args.mode == "usb":  simulate_usb(args.edf, args.port, args.baud)
    elif args.mode == "bt":   simulate_bt(args.edf)
    else:
        parser.print_help()

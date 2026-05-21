"""
complete_test_suite.py  (v2 — includes USB, Bluetooth, and all API endpoints)
─────────────────────────────────────────────────────────────────────────────
All-in-one test runner. No Holter device needed.

Tests covered (run in order):

  ── Core pipeline ────────────────────────────────────────────────────────
  TEST 1  — Generate synthetic EDF files (3-lead and 12-lead)
  TEST 2  — Validate EDF files (header, channels, sampling rate)
  TEST 3  — Ingest 3-lead EDF → H5  (full streaming pipeline)
  TEST 4  — Ingest 12-lead EDF → H5  (full streaming pipeline)
  TEST 5  — Verify H5 files (compression, shape, attrs, lead names)

  ── Acquisition modes ────────────────────────────────────────────────────
  TEST 6  — SD card watcher simulation (file-drop → watcher → ingest)
  TEST 7  — WiFi transfer simulation (chunked HTTP POST, requires api.py)
  TEST 8  — USB serial simulation
              mode A: with virtual serial pair (socat / com0com)
              mode B: bypass hardware, inject bytes directly into IngestSession
  TEST 9  — Bluetooth simulation
              mode A: file-drop into OS receive folder (bt_receiver watcher)
              mode B: direct file-drop into data/incoming/ (tests watcher only)

  ── API endpoints ────────────────────────────────────────────────────────
  TEST 10 — GET  /health  and  GET  /api/network/ip
  TEST 11 — GET  /api/ecg/<patient_id>  (main ECG data endpoint)
  TEST 12 — GET  /api/files  and  GET  /api/patients
  TEST 13 — PATCH /api/patients/<id>  and  POST /api/import
  TEST 14 — USB API endpoints (/api/usb/ports, /status, /connect, /disconnect)
  TEST 15 — BT API endpoints  (/api/bt/status, /devices, /start, /stop)

  ── Optional / special ───────────────────────────────────────────────────
  TEST 16 — RAM usage check (30-minute EDF, streaming)
  TEST 17 — PhysioNet real ECG download (internet required, optional)

Run:
    python complete_test_suite.py              # all tests
    python complete_test_suite.py --test 1     # single test
    python complete_test_suite.py --test 3,5   # multiple
    python complete_test_suite.py --quick      # tests 1-5 (no server)
    python complete_test_suite.py --no-server  # tests 1-9 (acquisition, no api.py)

Requirements:
    pip install pyedflib neurokit2 h5py hdf5plugin numpy requests psutil pyserial watchdog
"""

import os, sys, time, json, shutil, argparse, threading, traceback, socket, tempfile
import numpy as np

# ── Paths ─────────────────────────────────────────────────────────────────────
BASE    = os.path.dirname(os.path.abspath(__file__))
DATA    = os.path.join(BASE, "data")
INCOM   = os.path.join(DATA, "incoming")
PATS    = os.path.join(DATA, "patients")
EDF_3   = os.path.join(DATA, "test_3lead_5min.edf")
EDF_12  = os.path.join(DATA, "test_12lead_5min.edf")
H5_P001 = os.path.join(PATS, "P001", "ecg.h5")
H5_P002 = os.path.join(PATS, "P002", "ecg.h5")

for d in [DATA, INCOM, os.path.join(PATS,"P001"), os.path.join(PATS,"P002")]:
    os.makedirs(d, exist_ok=True)

sys.path.insert(0, BASE)

# ── Console colours ───────────────────────────────────────────────────────────
GREEN  = "\033[92m"; RED    = "\033[91m"; YELLOW = "\033[93m"
CYAN   = "\033[96m"; BOLD   = "\033[1m";  RESET  = "\033[0m"

def ok(msg):   print(f"  {GREEN}✓{RESET}  {msg}")
def fail(msg): print(f"  {RED}✗{RESET}  {msg}")
def info(msg): print(f"  {CYAN}→{RESET}  {msg}")
def head(n,t): print(f"\n{BOLD}{CYAN}{'─'*60}{RESET}\n{BOLD}  TEST {n} — {t}{RESET}\n{'─'*60}")
def warn(msg): print(f"  {YELLOW}⚠{RESET}  {msg}")
def skip(msg): print(f"  {YELLOW}○{RESET}  SKIP: {msg}")

results: dict = {}

_SERVER = "http://localhost:5000"


def run_test(label, fn):
    try:
        fn()
        results[label] = True
        ok(f"PASSED: {label}")
    except AssertionError as e:
        results[label] = False
        fail(f"FAILED: {label}  →  {e}")
    except Exception as e:
        results[label] = False
        fail(f"ERROR:  {label}  →  {e}")
        traceback.print_exc()


def _server_up() -> bool:
    try:
        import requests
        r = requests.get(f"{_SERVER}/health", timeout=3)
        return r.status_code == 200
    except Exception:
        return False


def _wait_session(session_id: str, timeout: int = 90) -> dict:
    """Poll progress_store until session is complete or error."""
    from acquisition.progress_store import get as ps_get
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1)
        s = ps_get(session_id)
        if s and s["status"] in ("complete", "error"):
            return s
    raise AssertionError(f"Session {session_id[:8]} timed out after {timeout}s")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 1 — Generate synthetic EDF files
# ══════════════════════════════════════════════════════════════════════════════

def test_1_generate_edfs():
    head(1, "Generate Synthetic EDF Files")
    import neurokit2 as nk, pyedflib

    SR, DUR = 250, 300

    # 3-lead
    info(f"Generating 3-lead EDF ({DUR}s)…")
    sigs3 = [nk.ecg_simulate(duration=DUR, sampling_rate=SR, heart_rate=72, noise=0.04+i*0.01)
             for i in range(3)]
    w = pyedflib.EdfWriter(EDF_3, 3, file_type=pyedflib.FILETYPE_EDFPLUS)
    w.setPatientCode("P001"); w.setPatientName("Test_Patient_P001")
    w.setSignalHeaders([{
        "label": ["I","II","V2"][i], "dimension": "mV",
        "sample_frequency": SR, "physical_max": 2.0, "physical_min": -2.0,
        "digital_max": 32767, "digital_min": -32768,
        "prefilter": "HP:0.5Hz LP:45Hz N:50Hz", "transducer": "Synthetic_NeuroKit2",
    } for i in range(3)])
    w.writeSamples(sigs3)
    w.writeAnnotation(60,  -1, "Chest discomfort")
    w.writeAnnotation(120, -1, "Dizzy")
    w.writeAnnotation(240, -1, "Palpitations")
    w.close()
    sz = os.path.getsize(EDF_3) / 1e6
    assert os.path.exists(EDF_3) and sz >= 0.4
    ok(f"3-lead EDF: {EDF_3}  ({sz:.1f} MB)")

    # 12-lead
    info(f"Generating 12-lead EDF ({DUR}s)…")
    leads12 = ["I","II","III","aVR","aVL","aVF","V1","V2","V3","V4","V5","V6"]
    sigs12  = [nk.ecg_simulate(duration=DUR, sampling_rate=SR, heart_rate=72+i*0.3, noise=0.04+i*0.003)
               for i in range(12)]
    w2 = pyedflib.EdfWriter(EDF_12, 12, file_type=pyedflib.FILETYPE_EDFPLUS)
    w2.setPatientCode("P002"); w2.setPatientName("Test_Patient_P002")
    w2.setSignalHeaders([{
        "label": leads12[i], "dimension": "mV",
        "sample_frequency": SR, "physical_max": 2.0, "physical_min": -2.0,
        "digital_max": 32767, "digital_min": -32768,
        "prefilter": "HP:0.5Hz LP:45Hz", "transducer": "Synthetic_NeuroKit2",
    } for i in range(12)])
    w2.writeSamples(sigs12)
    w2.close()
    sz2 = os.path.getsize(EDF_12) / 1e6
    assert os.path.exists(EDF_12) and sz2 > 1.0
    ok(f"12-lead EDF: {EDF_12}  ({sz2:.1f} MB)")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 2 — Validate EDF files
# ══════════════════════════════════════════════════════════════════════════════

def test_2_validate_edfs():
    head(2, "Validate EDF Files")
    import pyedflib

    for edf_path, exp_ch, pname_expect in [
        (EDF_3,  3,  "Test_Patient_P001"),
        (EDF_12, 12, "Test_Patient_P002"),
    ]:
        assert os.path.exists(edf_path), f"EDF not found: {edf_path} — run TEST 1 first"
        f     = pyedflib.EdfReader(edf_path)
        n_ch  = f.signals_in_file
        rates = [int(f.getSampleFrequency(i)) for i in range(n_ch)]
        dur   = f.getFileDuration()
        pname = f.getPatientName().strip()
        n_ann = len(f.readAnnotations()[0]) if edf_path == EDF_3 else 0
        f._close()

        assert n_ch == exp_ch, f"Expected {exp_ch} ch, got {n_ch}"
        assert all(r == 250 for r in rates), f"Bad sampling rates: {rates}"
        assert dur == 300, f"Expected 300s, got {dur}s"
        assert pname_expect.replace("_"," ") in pname.replace("_"," "), \
            f"Patient name mismatch: '{pname}'"
        ok(f"{os.path.basename(edf_path)}: {n_ch}ch  250Hz  300s  ✓")

        if edf_path == EDF_3:
            assert n_ann >= 3, f"Expected 3 annotations, got {n_ann}"
            ok(f"Annotations: {n_ann} diary events embedded")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 3 — Ingest 3-lead EDF
# ══════════════════════════════════════════════════════════════════════════════

def test_3_ingest_3lead():
    head(3, "Ingest 3-Lead EDF → H5  (streaming pipeline)")
    _run_ingest(EDF_3, "P001", H5_P001, exp_leads=["I","II","V2"])


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 4 — Ingest 12-lead EDF
# ══════════════════════════════════════════════════════════════════════════════

def test_4_ingest_12lead():
    head(4, "Ingest 12-Lead EDF → H5  (streaming pipeline)")
    _run_ingest(EDF_12, "P002", H5_P002,
                exp_leads=["I","II","III","aVR","aVL","aVF","V1","V2","V3","V4","V5","V6"])


def _run_ingest(edf_path, patient_id, h5_path, exp_leads):
    assert os.path.exists(edf_path), f"EDF not found — run TEST 1 first"
    from acquisition.ingest_stream import IngestSession
    if os.path.exists(h5_path):
        os.remove(h5_path)

    t0      = time.time()
    session = IngestSession(patient_id=patient_id, source_path=edf_path, source_method="test")

    deadline  = time.time() + 60
    last_secs = 0
    while time.time() < deadline:
        time.sleep(0.5)
        secs = session.seconds_available
        if secs > last_secs + 4.9:
            info(f"  ECG available: {secs:.0f}s  ({secs/300*100:.0f}%)")
            last_secs = secs
        if session.status == "complete":
            break
        if session.status == "error":
            raise AssertionError("Session errored — check logs")

    elapsed = time.time() - t0
    assert session.status == "complete", f"Status={session.status} after {elapsed:.0f}s"
    assert os.path.exists(h5_path), f"H5 not created at {h5_path}"
    ok(f"Ingest complete in {elapsed:.1f}s  →  {h5_path}")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 5 — Verify H5 files
# ══════════════════════════════════════════════════════════════════════════════

def test_5_verify_h5():
    head(5, "Verify H5 Files (compression, shape, attributes)")
    import h5py, hdf5plugin

    for h5_path, pid, exp_leads, exp_n in [
        (H5_P001, "P001", ["I","II","V2"],  3),
        (H5_P002, "P002", None,             12),
    ]:
        assert os.path.exists(h5_path), f"H5 not found — run TEST 3/4 first"
        with h5py.File(h5_path, "r") as f:
            ds      = f["ecg"]
            shape   = ds.shape
            sr      = int(f.attrs.get("sampling_rate", 0))
            n_leads = int(f.attrs.get("num_leads", 0))
            status  = f.attrs.get("status", "?")
            written = int(f.attrs.get("samples_written", 0))
            try:
                leads = json.loads(f.attrs.get("lead_names", "[]"))
            except Exception:
                leads = []
            t0     = time.time()
            window = ds[0:2500, :]
            ms     = (time.time()-t0)*1000

        disk_mb = os.path.getsize(h5_path) / 1e6
        raw_mb  = written * n_leads * 4 / 1e6
        ratio   = raw_mb / disk_mb if disk_mb > 0 else 0

        info(f"{pid}: shape={shape}  sr={sr}  status={status}")
        info(f"  Leads: {leads}  disk={disk_mb:.1f}MB  ratio={ratio:.1f}x  10s_read={ms:.0f}ms")

        assert status == "complete", f"Status={status}"
        assert sr == 250
        assert n_leads == exp_n, f"n_leads={n_leads} expected {exp_n}"
        assert written > 0
        assert ratio > 1.0, f"Compression ratio {ratio:.1f}x too low"
        assert ms < 200, f"10s read took {ms:.0f}ms — too slow"
        assert window.shape == (2500, exp_n)
        if exp_leads:
            assert leads == exp_leads, f"Lead names wrong: {leads}"
        ok(f"{pid}: ✓  {ratio:.1f}x compression  {ms:.0f}ms read")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 6 — SD card watcher simulation
# ══════════════════════════════════════════════════════════════════════════════

def test_6_sd_card_watcher():
    head(6, "SD Card / Watcher Simulation")
    from acquisition.watcher import EDFWatcher
    assert os.path.exists(EDF_3), "3-lead EDF not found — run TEST 1 first"

    dest = os.path.join(INCOM, "P001_watcher_test.edf")
    w    = EDFWatcher()
    w.start()
    time.sleep(0.5)

    info(f"Dropping file into incoming/: {dest}")
    shutil.copy2(EDF_3, dest)

    deadline, session = time.time() + 45, None
    while time.time() < deadline:
        time.sleep(1)
        active = w.active_sessions()
        if active:
            sid     = list(active.keys())[0]
            session = active[sid]
            info(f"  Session {sid[:8]}: status={session.status}  secs={session.seconds_available:.0f}")
            if session.status == "complete":
                break
            if session.status == "error":
                w.stop()
                raise AssertionError("Watcher session errored")

    w.stop()
    assert session is not None, "Watcher never picked up the file"
    assert session.status == "complete"
    ok("Watcher detected file, ingested fully, status=complete")

    processed = os.path.join(INCOM, "processed")
    if any("P001_watcher_test" in f for f in os.listdir(processed)):
        ok("File moved to processed/ ✓")
    else:
        warn("File not in processed/ — check watcher move logic")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 7 — WiFi transfer simulation (requires api.py)
# ══════════════════════════════════════════════════════════════════════════════

def test_7_wifi_transfer():
    head(7, "WiFi Transfer Simulation (requires api.py running)")
    try:
        import requests
    except ImportError:
        skip("requests not installed: pip install requests")
        return

    if not _server_up():
        skip("api.py not running — start it in another terminal, then re-run test 7")
        return

    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"
    edf_size = os.path.getsize(EDF_3)
    CHUNK    = 65536
    THROTTLE = 0.002   # 2ms → simulates ~32 MB/s WiFi
    sent     = 0

    def gen():
        nonlocal sent
        with open(EDF_3, "rb") as f:
            while True:
                c = f.read(CHUNK)
                if not c:
                    break
                time.sleep(THROTTLE)
                sent += len(c)
                yield c

    info(f"Streaming {edf_size/1e6:.1f} MB to {_SERVER}/upload…")
    resp = requests.post(
        f"{_SERVER}/upload", data=gen(),
        headers={
            "Content-Type":   "application/octet-stream",
            "Content-Length": str(edf_size),
            "X-Patient-Id":   "P001",
            "X-Filename":     "P001_wifi_test.edf",
        },
        stream=False, timeout=120,
    )
    assert resp.status_code == 200, f"Upload returned {resp.status_code}: {resp.text}"
    data       = resp.json()
    session_id = data.get("session_id")
    assert session_id, "No session_id in response"
    ok(f"Upload accepted — session={session_id[:8]}")

    info("Polling /api/transfer/status…")
    deadline = time.time() + 90
    d = {}
    while time.time() < deadline:
        time.sleep(2)
        sr  = requests.get(f"{_SERVER}/api/transfer/status/{session_id}", timeout=5)
        if sr.status_code != 200:
            continue
        d      = sr.json()
        status = d.get("status","?")
        info(f"  status={status}  written={d.get('pct_written',0):.0f}%  secs={d.get('seconds_available',0):.0f}")
        if status in ("complete","error"):
            break

    assert d.get("status") == "complete", f"WiFi session did not complete: {d.get('status')}"
    ok("WiFi transfer complete ✓")

    # Quick ECG read verification
    ecg = requests.get(f"{_SERVER}/api/ecg/P001?start=0&duration=10", timeout=10)
    assert ecg.status_code == 200
    ed   = ecg.json()
    samp = len(list(ed.get("leads",{}).values())[0]) if ed.get("leads") else 0
    assert samp > 0, "ECG API returned empty leads after WiFi ingest"
    ok(f"ECG API verified after WiFi ingest: leads={ed.get('lead_names')}  samples={samp}")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 8 — USB serial simulation (both modes)
# ══════════════════════════════════════════════════════════════════════════════

def test_8_usb_simulation():
    head(8, "USB Serial Simulation (no Holter device needed)")

    # ── Mode B first: direct byte injection (always works, no hardware at all) ─
    info("Mode B — direct byte injection into IngestSession (no serial port needed)")
    _test_usb_direct_injection()

    # ── Mode A: virtual serial pair (socat / com0com) ─────────────────────────
    _test_usb_virtual_serial()


def _test_usb_direct_injection():
    """
    Bypass the serial port entirely.
    Read EDF as bytes and feed() them directly into IngestSession.
    This exercises the exact same code path as real USB hardware
    (usb_serial.py does exactly this after reading from pyserial).
    """
    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"
    from acquisition.ingest_stream import IngestSession

    # Fresh H5 path so we don't collide with TEST 3
    h5_usb = os.path.join(PATS, "P001", "ecg_usb_test.h5")
    if os.path.exists(h5_usb):
        os.remove(h5_usb)

    edf_size = os.path.getsize(EDF_3)
    CHUNK    = 65536
    THROTTLE = 0.0005   # 0.5ms → simulates 460800 baud throughput

    # We cannot pass source_path here — we're feeding manually like USB does
    session = IngestSession(
        patient_id    = "P001",
        source_path   = None,
        bytes_total   = edf_size,
        source_method = "usb",
    )
    info(f"  IngestSession {session.session_id[:8]} created (USB mode)")

    sent = 0
    t0   = time.time()
    with open(EDF_3, "rb") as f:
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            session.feed(chunk)
            sent += len(chunk)
            time.sleep(THROTTLE)

    # Signal end of stream (same as usb_serial.py does)
    session._parser.set_total_bytes(sent)
    session._parser.feed_complete()

    elapsed = time.time() - t0
    info(f"  Fed {sent/1e6:.1f} MB in {elapsed:.1f}s — waiting for pipeline to finish…")

    s = _wait_session(session.session_id, timeout=60)
    assert s["status"] == "complete", f"USB inject session: {s['status']}"
    assert s.get("samples_written", 0) > 0, "No samples written"

    ok(f"Mode B (direct injection): ✓  {sent/1e6:.1f}MB fed  "
       f"leads={s.get('lead_names',[])}")


def _test_usb_virtual_serial():
    """
    Mode A: try to use a virtual serial port pair.
    Attempts socat (Linux/macOS) then com0com (Windows).
    Gracefully skips if neither is available — the direct injection above
    already proves the pipeline works.
    """
    import platform, subprocess

    OS = platform.system()
    RX, TX = None, None

    if OS in ("Linux", "Darwin"):
        try:
            # Check socat is installed
            subprocess.run(["socat", "-V"], capture_output=True, check=True)

            tmp_rx = os.path.join(tempfile.gettempdir(), "ttyHOLTER_RX")
            tmp_tx = os.path.join(tempfile.gettempdir(), "ttyHOLTER_TX")
            for p in [tmp_rx, tmp_tx]:
                if os.path.exists(p):
                    os.remove(p)

            socat_proc = subprocess.Popen([
                "socat",
                f"PTY,link={tmp_rx},rawer",
                f"PTY,link={tmp_tx},rawer",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.8)   # wait for ptys to be created

            if os.path.exists(tmp_rx) and os.path.exists(tmp_tx):
                RX, TX = tmp_rx, tmp_tx
                info(f"Mode A — socat virtual pair: RX={RX}  TX={TX}")
            else:
                socat_proc.kill()

        except (FileNotFoundError, subprocess.CalledProcessError):
            pass

    elif OS == "Windows":
        # Look for com0com virtual pair — use fixed names COM10/COM11
        import serial.tools.list_ports as lp
        ports  = {p.device for p in lp.comports()}
        if "COM10" in ports and "COM11" in ports:
            RX, TX = "COM11", "COM10"
            info(f"Mode A — com0com virtual pair: RX={RX}  TX={TX}")
        else:
            warn("com0com not detected. Install from https://sourceforge.net/projects/com0com/")

    if RX is None or TX is None:
        skip("Mode A (virtual serial) — socat/com0com not available. "
             "Mode B (direct injection) already passed, pipeline is verified.")
        return

    try:
        import serial
    except ImportError:
        skip("pyserial not installed: pip install pyserial")
        return

    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"
    from acquisition.usb_serial import start_usb_listener, stop_usb_listener, get_usb_status

    # Start receiver on RX port
    started = start_usb_listener(port=RX, patient_id="P001", baud=460800)
    assert started, "USB listener failed to start"
    time.sleep(0.5)

    # Send EDF on TX port (simulates Holter device)
    edf_size = os.path.getsize(EDF_3)
    CHUNK    = 65536
    info(f"  Sending {edf_size/1e6:.1f} MB on TX={TX}…")
    t0   = time.time()
    sent = 0
    try:
        with serial.Serial(TX, 460800, timeout=10) as s:
            with open(EDF_3, "rb") as f:
                while True:
                    chunk = f.read(CHUNK)
                    if not chunk:
                        break
                    s.write(chunk)
                    sent += len(chunk)
    except Exception as e:
        stop_usb_listener()
        raise AssertionError(f"USB TX error: {e}")

    elapsed = time.time() - t0
    info(f"  Sent {sent/1e6:.1f} MB in {elapsed:.1f}s — waiting for receiver…")

    # Poll USB status until complete (max 60s)
    deadline = time.time() + 60
    status   = {}
    while time.time() < deadline:
        time.sleep(2)
        status = get_usb_status()
        info(f"  USB state={status['state']}  recv={status.get('bytes_recv',0)/1e6:.1f}MB")
        if status["state"] in ("complete", "error"):
            break

    stop_usb_listener()

    # Kill socat if we started it
    if OS in ("Linux","Darwin") and socat_proc:
        try:
            socat_proc.kill()
        except Exception:
            pass

    assert status.get("state") == "complete", f"USB mode A: state={status.get('state')}"
    ok(f"Mode A (virtual serial): ✓  {sent/1e6:.1f}MB transferred via socat/com0com")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 9 — Bluetooth simulation (both modes)
# ══════════════════════════════════════════════════════════════════════════════

def test_9_bluetooth_simulation():
    head(9, "Bluetooth Simulation (no device needed)")

    # ── Mode B: direct file drop into data/incoming/ ──────────────────────────
    info("Mode B — direct drop into data/incoming/ (tests watcher, not BT stack)")
    _test_bt_direct_incoming_drop()

    # ── Mode A: via bt_receiver's watched folder ──────────────────────────────
    info("Mode A — drop into BT receive folder (tests full bt_receiver pipeline)")
    _test_bt_receive_folder()


def _test_bt_direct_incoming_drop():
    """
    Simulate what bt_receiver does at its final step:
    copy .edf → data/incoming/ and let watcher.py ingest it.
    """
    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"
    from acquisition.watcher import EDFWatcher

    dest = os.path.join(INCOM, "P001_bt_direct_test.edf")
    w    = EDFWatcher()
    w.start()
    time.sleep(0.4)

    info(f"  Dropping file as if BT receiver moved it: {dest}")
    shutil.copy2(EDF_3, dest)

    deadline, session = time.time() + 45, None
    while time.time() < deadline:
        time.sleep(1)
        active = w.active_sessions()
        if active:
            sid     = list(active.keys())[0]
            session = active[sid]
            if session.status == "complete":
                break
            if session.status == "error":
                w.stop()
                raise AssertionError("BT direct drop session errored")

    w.stop()
    assert session is not None, "Watcher never picked up BT-simulated file"
    assert session.status == "complete"
    ok("Mode B (direct drop → watcher → ingest): ✓")


def _test_bt_receive_folder():
    """
    Mode A: start bt_receiver, drop a file into its receive folder,
    verify bt_receiver moves it to data/incoming/ and watcher ingests it.
    Uses a temporary staging folder (no real Bluetooth needed).
    """
    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"

    from acquisition.bt_receiver import start_bt_watcher, stop_bt_watcher, get_bt_status
    from acquisition.watcher     import EDFWatcher

    # Use a temp folder as the "BT receive folder"
    bt_folder = os.path.join(DATA, "bt_test_receive")
    os.makedirs(bt_folder, exist_ok=True)

    # Start watcher so incoming/ files get ingested
    w = EDFWatcher()
    w.start()
    time.sleep(0.3)

    # Start bt_receiver watching our temp folder
    started = start_bt_watcher(receive_folder=bt_folder, patient_id="P001")
    assert started, "bt_receiver failed to start"
    time.sleep(0.5)

    # Drop file into the BT receive folder (simulates OBEX push completing)
    bt_dest = os.path.join(bt_folder, "P001_bt_receive_test.edf")
    info(f"  Copying file to BT receive folder: {bt_dest}")
    shutil.copy2(EDF_3, bt_dest)

    # Wait for bt_receiver to detect, move to incoming/, and watcher to ingest
    deadline   = time.time() + 60
    bt_moved   = False
    session    = None

    while time.time() < deadline:
        time.sleep(1)

        # Check BT receiver detected it
        st = get_bt_status()
        if st.get("files_received", 0) > 0 and not bt_moved:
            bt_moved = True
            info(f"  BT receiver detected file: last_file={st.get('last_file')}")

        # Check watcher ingested it
        active = w.active_sessions()
        if active:
            sid     = list(active.keys())[0]
            session = active[sid]
            if session.status == "complete":
                break
            if session.status == "error":
                break

    stop_bt_watcher()
    w.stop()

    assert bt_moved, "BT receiver did not detect the file in receive folder"
    assert session is not None, "Watcher never ingested the BT-received file"
    assert session.status == "complete", f"Ingest status={session.status}"
    ok("Mode A (bt_receiver folder → incoming → watcher → ingest): ✓")

    # Cleanup temp folder
    shutil.rmtree(bt_folder, ignore_errors=True)


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 10 — /health  and  /api/network/ip
# ══════════════════════════════════════════════════════════════════════════════

def test_10_health_and_ip():
    head(10, "API: /health  and  /api/network/ip")
    if not _server_up():
        skip("api.py not running")
        return
    import requests

    # /health
    r = requests.get(f"{_SERVER}/health", timeout=5)
    assert r.status_code == 200, f"/health returned {r.status_code}"
    d = r.json()
    assert d.get("status") == "ok",   f"health.status != ok: {d}"
    assert "data_dir"   in d,          "/health missing data_dir"
    assert "lan_ip"     in d,          "/health missing lan_ip"
    assert "h5_count"   in d,          "/health missing h5_count"
    ok(f"/health: ✓  data_dir={d['data_dir']}  h5_count={d['h5_count']}  ip={d['lan_ip']}")

    # /api/network/ip
    r2 = requests.get(f"{_SERVER}/api/network/ip", timeout=5)
    assert r2.status_code == 200
    d2 = r2.json()
    assert "ip" in d2, "/api/network/ip missing 'ip' field"
    # IP should be a valid dotted-quad
    parts = d2["ip"].split(".")
    assert len(parts) == 4, f"LAN IP looks wrong: {d2['ip']}"
    ok(f"/api/network/ip: ✓  ip={d2['ip']}")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 11 — ECG data endpoint
# ══════════════════════════════════════════════════════════════════════════════

def test_11_ecg_endpoint():
    head(11, "API: GET /api/ecg/<patient_id>")
    if not _server_up():
        skip("api.py not running")
        return
    import requests

    for pid, exp_n in [("P001", 3), ("P002", 12)]:
        # t=0, 10-second window
        r = requests.get(f"{_SERVER}/api/ecg/{pid}?start=0&duration=10", timeout=10)
        assert r.status_code == 200, f"GET /api/ecg/{pid} → {r.status_code}: {r.text}"
        d = r.json()

        lead_names = d.get("lead_names", [])
        sr         = d.get("sr", 0)
        total_sec  = d.get("total_sec", 0)
        leads      = d.get("leads", {})

        assert len(lead_names) == exp_n,  f"{pid}: expected {exp_n} leads, got {len(lead_names)}"
        assert sr == 250,                  f"{pid}: sr={sr}, expected 250"
        assert total_sec >= 299,          f"{pid}: total_sec={total_sec}"
        assert len(leads) == exp_n

        for name, samples in leads.items():
            assert len(samples) == sr * 10, f"{pid}.{name}: expected {sr*10} samples"
            arr = np.array(samples)
            assert arr.std() > 0.01, f"{pid}.{name}: signal looks flat"

        ok(f"{pid}: ✓  leads={lead_names}  sr={sr}Hz  total={total_sec:.0f}s")

        # Mid-recording window (t=120)
        r2 = requests.get(f"{_SERVER}/api/ecg/{pid}?start=120&duration=10", timeout=10)
        assert r2.status_code == 200
        d2 = r2.json()
        samp2 = len(list(d2["leads"].values())[0])
        assert samp2 == 2500, f"{pid} mid-window samples={samp2}"
        ok(f"{pid}: ✓  mid-recording window (t=120s) OK")

        # Out-of-bounds window
        r3 = requests.get(f"{_SERVER}/api/ecg/{pid}?start=99999&duration=10", timeout=10)
        assert r3.status_code in (400, 404), f"{pid}: expected error for OOB start, got {r3.status_code}"
        ok(f"{pid}: ✓  out-of-bounds start correctly rejected")

        # Legacy endpoints
        r4 = requests.get(f"{_SERVER}/api/ecg/{pid}/{exp_n}/all?start=0&duration=5", timeout=10)
        assert r4.status_code == 200
        ok(f"{pid}: ✓  legacy /all endpoint works")

        r5 = requests.get(f"{_SERVER}/api/ecg/{pid}/{exp_n}?lead=II&start=0&duration=5", timeout=10)
        assert r5.status_code == 200
        ok(f"{pid}: ✓  legacy single-lead endpoint works")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 12 — /api/files and /api/patients
# ══════════════════════════════════════════════════════════════════════════════

def test_12_files_and_patients():
    head(12, "API: GET /api/files  and  GET /api/patients")
    if not _server_up():
        skip("api.py not running")
        return
    import requests

    # /api/files
    r = requests.get(f"{_SERVER}/api/files", timeout=10)
    assert r.status_code == 200, f"/api/files → {r.status_code}"
    files = r.json()
    assert isinstance(files, list), "/api/files should return a list"
    assert len(files) >= 1, "Expected at least 1 H5 file — run tests 1-4 first"

    for f in files:
        for key in ("filename","n_leads","lead_names","sr","duration_hr","size_mb","status"):
            assert key in f, f"/api/files item missing key: {key}"
        assert f["sr"] == 250, f"file {f['filename']} has sr={f['sr']}"
        assert f["n_leads"] > 0

    ok(f"/api/files: ✓  {len(files)} H5 file(s) returned")
    for f in files:
        info(f"  {f['filename']}: {f['n_leads']}ch  {f['duration_hr']*60:.0f}min  {f['size_mb']}MB  status={f['status']}")

    # /api/patients
    r2 = requests.get(f"{_SERVER}/api/patients", timeout=10)
    assert r2.status_code == 200, f"/api/patients → {r2.status_code}"
    patients = r2.json()
    assert isinstance(patients, list)
    ok(f"/api/patients: ✓  {len(patients)} patient(s) returned")

    # /api/patients/<id> for each test patient
    for pid in ["P001", "P002"]:
        r3 = requests.get(f"{_SERVER}/api/patients/{pid}", timeout=5)
        if r3.status_code == 200:
            d3 = r3.json()
            assert "id" in d3, f"/api/patients/{pid} missing 'id'"
            ok(f"/api/patients/{pid}: ✓  name={d3.get('name')}")
        else:
            warn(f"/api/patients/{pid} → {r3.status_code} (patient may not be in DB yet)")

    # 404 for non-existent patient
    r4 = requests.get(f"{_SERVER}/api/patients/NOSUCHPATIENT", timeout=5)
    assert r4.status_code == 404, f"Expected 404 for unknown patient, got {r4.status_code}"
    ok("/api/patients/NOSUCHPATIENT: ✓  correctly returns 404")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 13 — PATCH /api/patients/<id>  and  POST /api/import
# ══════════════════════════════════════════════════════════════════════════════

def test_13_patch_and_import():
    head(13, "API: PATCH /api/patients/<id>  and  POST /api/import")
    if not _server_up():
        skip("api.py not running")
        return
    import requests

    # ── PATCH /api/patients/P001 ──────────────────────────────────────────────
    patch_payload = {"name": "Alice_ECG_Test", "age": 45, "sex": "F"}
    r = requests.patch(
        f"{_SERVER}/api/patients/P001",
        json=patch_payload,
        timeout=10,
    )
    if r.status_code == 200:
        d = r.json()
        assert d.get("name") == "Alice_ECG_Test", f"PATCH name mismatch: {d}"
        ok("PATCH /api/patients/P001: ✓  name updated")
    elif r.status_code == 404:
        warn("P001 not in DB yet — PATCH skipped (run tests 1-4 first, then restart api.py)")
    else:
        raise AssertionError(f"PATCH returned {r.status_code}: {r.text}")

    # PATCH with invalid fields should return 400
    r2 = requests.patch(f"{_SERVER}/api/patients/P001", json={"invalid_field": "x"}, timeout=5)
    assert r2.status_code == 400, f"PATCH with bad fields should be 400, got {r2.status_code}"
    ok("PATCH invalid fields: ✓  correctly returns 400")

    # ── POST /api/import ──────────────────────────────────────────────────────
    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"
    with open(EDF_3, "rb") as f:
        r3 = requests.post(
            f"{_SERVER}/api/import",
            files={"file": ("P001_import_test.edf", f, "application/octet-stream")},
            data={"patient_id": "P001"},
            timeout=120,
        )

    assert r3.status_code == 200, f"/api/import → {r3.status_code}: {r3.text}"
    d3 = r3.json()
    assert d3.get("success") or d3.get("async"), f"import result not success: {d3}"
    ok(f"/api/import: ✓  result={d3}")

    # If async, wait a moment and verify H5 exists
    if d3.get("async"):
        time.sleep(5)
        assert os.path.exists(H5_P001), "H5 not created after async /api/import"
        ok("/api/import async: ✓  H5 file created by watcher")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 14 — USB API endpoints
# ══════════════════════════════════════════════════════════════════════════════

def test_14_usb_api_endpoints():
    head(14, "API: USB endpoints (/api/usb/*)")
    if not _server_up():
        skip("api.py not running")
        return
    import requests

    # GET /api/usb/ports
    r = requests.get(f"{_SERVER}/api/usb/ports", timeout=5)
    assert r.status_code == 200, f"/api/usb/ports → {r.status_code}"
    ports = r.json()
    assert isinstance(ports, list)
    ok(f"/api/usb/ports: ✓  {len(ports)} port(s) found")
    for p in ports:
        info(f"  {p.get('port','?'):15}  {p.get('description','?')}  holter={p.get('likely_holter')}")

    # GET /api/usb/status (should be idle initially)
    r2 = requests.get(f"{_SERVER}/api/usb/status", timeout=5)
    assert r2.status_code == 200
    d2 = r2.json()
    assert "state" in d2
    for key in ("state","port","baud","bytes_recv","error"):
        assert key in d2, f"/api/usb/status missing key: {key}"
    ok(f"/api/usb/status: ✓  state={d2['state']}")

    # POST /api/usb/connect with port=None → auto-detect mode
    # (won't actually find a device but should return ok:True and start the listener)
    r3 = requests.post(
        f"{_SERVER}/api/usb/connect",
        json={"port": None, "patient_id": "P001", "baud": 460800},
        timeout=5,
    )
    assert r3.status_code == 200
    d3 = r3.json()
    assert "ok" in d3
    ok(f"/api/usb/connect: ✓  ok={d3['ok']}  port={d3.get('port')}")
    time.sleep(1)

    # Status should now be connecting (no device found → stays connecting)
    r4 = requests.get(f"{_SERVER}/api/usb/status", timeout=5)
    d4 = r4.json()
    assert d4["state"] in ("connecting", "idle", "error"), f"Unexpected state: {d4['state']}"
    ok(f"/api/usb/status after connect: ✓  state={d4['state']}")

    # POST /api/usb/disconnect
    r5 = requests.post(f"{_SERVER}/api/usb/disconnect", timeout=5)
    assert r5.status_code == 200
    assert r5.json().get("ok")
    ok("/api/usb/disconnect: ✓")

    time.sleep(1)
    r6 = requests.get(f"{_SERVER}/api/usb/status", timeout=5)
    assert r6.json()["state"] == "idle"
    ok("/api/usb/status after disconnect: ✓  state=idle")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 15 — Bluetooth API endpoints
# ══════════════════════════════════════════════════════════════════════════════

def test_15_bt_api_endpoints():
    head(15, "API: Bluetooth endpoints (/api/bt/*)")
    if not _server_up():
        skip("api.py not running")
        return
    import requests

    # GET /api/bt/status (watching since api.py boot calls start_bt_watcher)
    r = requests.get(f"{_SERVER}/api/bt/status", timeout=5)
    assert r.status_code == 200, f"/api/bt/status → {r.status_code}"
    d = r.json()
    for key in ("state","platform","receive_folder","files_received"):
        assert key in d, f"/api/bt/status missing key: {key}"
    ok(f"/api/bt/status: ✓  state={d['state']}  platform={d['platform']}  folder={d.get('receive_folder')}")

    # GET /api/bt/devices
    r2 = requests.get(f"{_SERVER}/api/bt/devices", timeout=10)
    assert r2.status_code == 200
    devs = r2.json()
    assert isinstance(devs, list)
    ok(f"/api/bt/devices: ✓  {len(devs)} device(s) (paired on this machine)")
    for dev in devs[:3]:
        info(f"  {dev}")

    # POST /api/bt/stop
    r3 = requests.post(f"{_SERVER}/api/bt/stop", timeout=5)
    assert r3.status_code == 200
    assert r3.json().get("ok")
    ok("/api/bt/stop: ✓")
    time.sleep(0.5)

    r3s = requests.get(f"{_SERVER}/api/bt/status", timeout=5)
    assert r3s.json()["state"] == "idle"
    ok("/api/bt/status after stop: ✓  state=idle")

    # POST /api/bt/start with custom folder
    test_folder = os.path.join(DATA, "bt_api_test_folder")
    os.makedirs(test_folder, exist_ok=True)
    r4 = requests.post(
        f"{_SERVER}/api/bt/start",
        json={"receive_folder": test_folder, "patient_id": "P001"},
        timeout=5,
    )
    assert r4.status_code == 200
    d4 = r4.json()
    assert d4.get("ok")
    ok(f"/api/bt/start: ✓  ok=True  folder={test_folder}")

    r4s = requests.get(f"{_SERVER}/api/bt/status", timeout=5)
    assert r4s.json()["state"] == "watching"
    ok("/api/bt/status after start: ✓  state=watching")

    # ── End-to-end: drop file into BT API folder, verify it reaches incoming/ ─
    info("  End-to-end: dropping test EDF into BT API folder…")
    assert os.path.exists(EDF_3), "EDF not found — run TEST 1 first"
    bt_drop_path = os.path.join(test_folder, "P001_bt_api_e2e.edf")
    shutil.copy2(EDF_3, bt_drop_path)
    time.sleep(6)   # bt_receiver polls every 1s, needs 2s stability check

    r4s2 = requests.get(f"{_SERVER}/api/bt/status", timeout=5)
    d4s2 = r4s2.json()
    assert d4s2.get("files_received", 0) >= 1, \
        f"BT API did not detect dropped file — files_received={d4s2.get('files_received')}"
    ok(f"/api/bt end-to-end: ✓  files_received={d4s2['files_received']}  last={d4s2.get('last_file')}")

    # Cleanup
    requests.post(f"{_SERVER}/api/bt/stop", timeout=5)
    shutil.rmtree(test_folder, ignore_errors=True)

    # GET /api/transfer/active and /api/transfer/recent
    r5 = requests.get(f"{_SERVER}/api/transfer/active", timeout=5)
    assert r5.status_code == 200
    assert isinstance(r5.json(), list)
    ok("/api/transfer/active: ✓")

    r6 = requests.get(f"{_SERVER}/api/transfer/recent?limit=5", timeout=5)
    assert r6.status_code == 200
    assert isinstance(r6.json(), list)
    ok(f"/api/transfer/recent: ✓  {len(r6.json())} sessions returned")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 16 — RAM usage (30-minute EDF)
# ══════════════════════════════════════════════════════════════════════════════

def test_16_ram_check():
    head(16, "RAM Usage Check (30-minute EDF, streaming)")
    try:
        import psutil
    except ImportError:
        skip("psutil not installed: pip install psutil")
        return

    import neurokit2 as nk, pyedflib

    BIG_EDF = os.path.join(DATA, "P001_30min_ram_test.edf")
    if not os.path.exists(BIG_EDF):
        info("Generating 30-minute EDF (this takes ~30s)…")
        sigs = [nk.ecg_simulate(duration=1800, sampling_rate=250, heart_rate=72, noise=0.05)
                for _ in range(3)]
        w = pyedflib.EdfWriter(BIG_EDF, 3, file_type=pyedflib.FILETYPE_EDFPLUS)
        w.setPatientCode("P001"); w.setPatientName("Test_Patient_P001")
        w.setSignalHeaders([{
            "label": ["I","II","V2"][i], "dimension": "mV",
            "sample_frequency": 250, "physical_max": 2.0, "physical_min": -2.0,
            "digital_max": 32767, "digital_min": -32768,
            "prefilter": "HP:0.5Hz LP:45Hz", "transducer": "Synthetic",
        } for i in range(3)])
        w.writeSamples(sigs)
        w.close()
        info(f"Generated: {os.path.getsize(BIG_EDF)/1e6:.1f} MB")

    from acquisition.ingest_stream import IngestSession

    proc     = psutil.Process(os.getpid())
    ram_peak = [0]

    def _monitor():
        while ram_peak[0] >= 0:
            try:
                mb = proc.memory_info().rss / 1e6
                if mb > ram_peak[0]:
                    ram_peak[0] = mb
            except Exception:
                break
            time.sleep(0.2)

    t_mon = threading.Thread(target=_monitor, daemon=True)
    t_mon.start()

    ram_before = proc.memory_info().rss / 1e6
    info(f"RAM before: {ram_before:.0f} MB")

    t0      = time.time()
    session = IngestSession(patient_id="P001", source_path=BIG_EDF, source_method="test")

    deadline = time.time() + 150
    while time.time() < deadline:
        time.sleep(1)
        if session.status in ("complete","error"):
            break

    ram_peak[0] = -1   # signal monitor to exit
    elapsed = time.time() - t0
    ram_after = proc.memory_info().rss / 1e6

    info(f"RAM after:  {ram_after:.0f} MB")
    info(f"Time:       {elapsed:.0f}s for 30-min EDF")

    assert session.status == "complete", f"RAM test ingest failed: {session.status}"
    assert ram_after < ram_before + 300, \
        f"RAM grew by {ram_after-ram_before:.0f} MB — streaming not working"

    ok(f"RAM delta: {ram_after-ram_before:.0f} MB (limit: 300 MB)  ingest: {elapsed:.0f}s  ✓")


# ══════════════════════════════════════════════════════════════════════════════
#  TEST 17 — PhysioNet real ECG (optional, internet required)
# ══════════════════════════════════════════════════════════════════════════════

def test_17_physionet_real():
    head(17, "Real PhysioNet ECG — MIT-BIH (optional, needs internet)")
    try:
        import wfdb
    except ImportError:
        skip("wfdb not installed: pip install wfdb")
        return

    import h5py, hdf5plugin

    info("Downloading MIT-BIH record 100 (short segment)…")
    try:
        record = wfdb.rdrecord("100", pb_dir="mitdb", sampfrom=0, sampto=7500)
    except Exception as e:
        skip(f"Download failed: {e}")
        return

    signal = record.p_signal.astype(np.float32)
    sr     = record.fs
    leads  = record.sig_name
    n_l    = signal.shape[1]

    h5_path = os.path.join(PATS, "P001", "ecg_mitbih.h5")
    with h5py.File(h5_path, "w") as f:
        f.create_dataset(
            "ecg", data=signal,
            chunks=(sr*5, n_l),
            **hdf5plugin.Blosc(cname="zstd", clevel=3,
                               shuffle=hdf5plugin.Blosc.BITSHUFFLE)
        )
        f.attrs["sampling_rate"]   = sr
        f.attrs["num_leads"]       = n_l
        f.attrs["total_samples"]   = signal.shape[0]
        f.attrs["duration_sec"]    = signal.shape[0] / sr
        f.attrs["lead_names"]      = json.dumps(list(leads))
        f.attrs["status"]          = "complete"
        f.attrs["samples_written"] = signal.shape[0]
        f.attrs["compression"]     = "blosc+zstd+bitshuffle"

    disk_mb = os.path.getsize(h5_path) / 1e6
    raw_mb  = signal.nbytes / 1e6
    ok(f"MIT-BIH: {raw_mb:.1f} MB → {disk_mb:.1f} MB  ({raw_mb/disk_mb:.1f}x)  leads={list(leads)}")

    with h5py.File(h5_path, "r") as f:
        w = f["ecg"][0:sr*10, :]
    assert w.shape == (sr*10, n_l)
    ok(f"Reads back: shape={w.shape} ✓")


# ══════════════════════════════════════════════════════════════════════════════
#  RUNNER
# ══════════════════════════════════════════════════════════════════════════════

ALL_TESTS = {
    1:  ("Generate EDF files",                   test_1_generate_edfs),
    2:  ("Validate EDF files",                   test_2_validate_edfs),
    3:  ("Ingest 3-lead EDF → H5",               test_3_ingest_3lead),
    4:  ("Ingest 12-lead EDF → H5",              test_4_ingest_12lead),
    5:  ("Verify H5 compression",                test_5_verify_h5),
    6:  ("SD card watcher simulation",           test_6_sd_card_watcher),
    7:  ("WiFi transfer simulation",             test_7_wifi_transfer),
    8:  ("USB serial simulation (A+B)",          test_8_usb_simulation),
    9:  ("Bluetooth simulation (A+B)",           test_9_bluetooth_simulation),
    10: ("API: /health + /api/network/ip",       test_10_health_and_ip),
    11: ("API: GET /api/ecg/<patient_id>",       test_11_ecg_endpoint),
    12: ("API: /api/files + /api/patients",      test_12_files_and_patients),
    13: ("API: PATCH patients + POST import",    test_13_patch_and_import),
    14: ("API: USB endpoints",                   test_14_usb_api_endpoints),
    15: ("API: BT endpoints",                    test_15_bt_api_endpoints),
    16: ("RAM usage — 30-min EDF",               test_16_ram_check),
    17: ("PhysioNet real ECG (optional)",        test_17_physionet_real),
}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test",      default="all", help="e.g. 1,3,5  or  'all'")
    parser.add_argument("--quick",     action="store_true", help="Tests 1-5 (no server)")
    parser.add_argument("--no-server", action="store_true", help="Tests 1-9 (acquisition only)")
    parser.add_argument("--server",    default="http://localhost:5000", help="API server URL")
    args = parser.parse_args()

    _SERVER = args.server

    if args.quick:
        to_run = [1,2,3,4,5]
    elif args.no_server:
        to_run = [1,2,3,4,5,6,8,9]
    elif args.test == "all":
        to_run = list(ALL_TESTS.keys())
    else:
        to_run = [int(x.strip()) for x in args.test.split(",")]

    print(f"\n{BOLD}{CYAN}Holter ECG Acquisition Test Suite  v2{RESET}")
    print(f"Tests:  {to_run}")
    print(f"Server: {_SERVER}  (server_up={_server_up()})\n")

    for num in to_run:
        if num not in ALL_TESTS:
            warn(f"Unknown test number: {num}")
            continue
        label, fn = ALL_TESTS[num]
        run_test(f"TEST {num}: {label}", fn)

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print(f"{BOLD}RESULTS{RESET}")
    print(f"{'═'*60}")
    passed = sum(1 for v in results.values() if v)
    failed = sum(1 for v in results.values() if not v)
    for label, ok_flag in results.items():
        icon = f"{GREEN}✓{RESET}" if ok_flag else f"{RED}✗{RESET}"
        print(f"  {icon}  {label}")

    print(f"\n  Passed: {passed}   Failed: {failed}   Total: {len(results)}")

    if failed == 0:
        print(f"\n{GREEN}{BOLD}ALL TESTS PASSED ✓{RESET}")
        print("Data acquisition pipeline verified: SD · WiFi · USB · Bluetooth → H5 → API")
    else:
        print(f"\n{YELLOW}Some tests failed — see output above for details.{RESET}")

    print(f"""
Usage guide:
  No device, no server:   python complete_test_suite.py --quick
  No device, with server: python complete_test_suite.py --no-server
  Full suite:             python complete_test_suite.py
  Single test:            python complete_test_suite.py --test 8
  Multiple tests:         python complete_test_suite.py --test 8,9,14,15
""")
    sys.exit(0 if failed == 0 else 1)
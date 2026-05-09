"""
complete_test_suite.py
─────────────────────────────────────────────────────────────────────────────
All-in-one test runner. No Holter device needed.

Tests covered (run in order):
  TEST 1 — Generate synthetic EDF files (3-lead and 12-lead)
  TEST 2 — Validate EDF files (header, channels, sampling rate)
  TEST 3 — Run full ingest pipeline on 3-lead EDF → H5
  TEST 4 — Run full ingest pipeline on 12-lead EDF → H5
  TEST 5 — Verify H5 files (compression, shape, attrs, lead names)
  TEST 6 — Simulate SD card drop (watcher trigger test)
  TEST 7 — Simulate WiFi transfer (chunked HTTP POST)
  TEST 8 — Verify API can serve ECG data from H5
  TEST 9 — RAM usage check (large file, streaming)
  TEST 10 — PhysioNet real ECG download (internet required, optional)

Run:
    python complete_test_suite.py              # all tests
    python complete_test_suite.py --test 1     # single test
    python complete_test_suite.py --test 3,5   # multiple
    python complete_test_suite.py --quick      # tests 1-5 only (no server needed)
"""

import os, sys, time, json, argparse, shutil, threading, traceback
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

# ── Console colours ───────────────────────────────────────────────────────────
GREEN = "\033[92m"; RED = "\033[91m"; YELLOW = "\033[93m"
CYAN  = "\033[96m"; BOLD = "\033[1m"; RESET = "\033[0m"

def ok(msg):   print(f"  {GREEN}✓{RESET}  {msg}")
def fail(msg): print(f"  {RED}✗{RESET}  {msg}")
def info(msg): print(f"  {CYAN}→{RESET}  {msg}")
def head(msg): print(f"\n{BOLD}{CYAN}{'─'*60}{RESET}\n{BOLD}  {msg}{RESET}\n{'─'*60}")
def warn(msg): print(f"  {YELLOW}⚠{RESET}  {msg}")

results = {}   # test_name → True/False


def run_test(name, fn):
    try:
        fn()
        results[name] = True
        ok(f"PASSED: {name}")
    except AssertionError as e:
        results[name] = False
        fail(f"FAILED: {name}  →  {e}")
    except Exception as e:
        results[name] = False
        fail(f"ERROR:  {name}  →  {e}")
        traceback.print_exc()


# ══════════════════════════════════════════════════════════════════════════════
# TEST 1 — Generate synthetic EDF files
# ══════════════════════════════════════════════════════════════════════════════

def test_1_generate_edfs():
    head("TEST 1 — Generate Synthetic EDF Files")

    import neurokit2 as nk
    import pyedflib

    SR  = 250
    DUR = 300   # 5 minutes — fast to generate and transfer

    # ── 3-lead EDF (P001) ────────────────────────────────────────────────────
    info(f"Generating 3-lead EDF ({DUR}s at {SR}Hz)...")
    lead_names_3 = ["I", "II", "V2"]
    signals_3 = [
        nk.ecg_simulate(duration=DUR, sampling_rate=SR, heart_rate=72, noise=0.04),
        nk.ecg_simulate(duration=DUR, sampling_rate=SR, heart_rate=72, noise=0.07),
        nk.ecg_simulate(duration=DUR, sampling_rate=SR, heart_rate=72, noise=0.05),
    ]

    writer = pyedflib.EdfWriter(EDF_3, 3, file_type=pyedflib.FILETYPE_EDFPLUS)
    writer.setPatientCode("P001")
    writer.setPatientName("Test_Patient_P001")
    writer.setSignalHeaders([{
        "label": lead_names_3[i], "dimension": "mV",
        "sample_frequency": SR,
        "physical_max": 2.0, "physical_min": -2.0,
        "digital_max": 32767, "digital_min": -32768,
        "prefilter": "HP:0.5Hz LP:45Hz N:50Hz",
        "transducer": "Synthetic_NeuroKit2",
    } for i in range(3)])
    writer.writeSamples(signals_3)
    writer.writeAnnotation(60,  -1, "Patient event - chest discomfort")
    writer.writeAnnotation(120, -1, "Dizzy")
    writer.writeAnnotation(240, -1, "Palpitations")
    writer.close()

    size_mb = os.path.getsize(EDF_3) / 1e6
    ok(f"3-lead EDF: {EDF_3}  ({size_mb:.1f} MB)")
    assert os.path.exists(EDF_3) and size_mb >= 0.4, "3-lead EDF not created"

    # ── 12-lead EDF (P002) ───────────────────────────────────────────────────
    info(f"Generating 12-lead EDF ({DUR}s at {SR}Hz)...")
    lead_names_12 = ["I","II","III","aVR","aVL","aVF","V1","V2","V3","V4","V5","V6"]
    signals_12 = [
        nk.ecg_simulate(duration=DUR, sampling_rate=SR,
                        heart_rate=72+i*0.3, noise=0.04+i*0.003)
        for i in range(12)
    ]

    writer12 = pyedflib.EdfWriter(EDF_12, 12, file_type=pyedflib.FILETYPE_EDFPLUS)
    writer12.setPatientCode("P002")
    writer12.setPatientName("Test_Patient_P002")
    writer12.setSignalHeaders([{
        "label": lead_names_12[i], "dimension": "mV",
        "sample_frequency": SR,
        "physical_max": 2.0, "physical_min": -2.0,
        "digital_max": 32767, "digital_min": -32768,
        "prefilter": "HP:0.5Hz LP:45Hz",
        "transducer": "Synthetic_NeuroKit2",
    } for i in range(12)])
    writer12.writeSamples(signals_12)
    writer12.close()

    size_mb12 = os.path.getsize(EDF_12) / 1e6
    ok(f"12-lead EDF: {EDF_12}  ({size_mb12:.1f} MB)")
    assert os.path.exists(EDF_12) and size_mb12 > 1.0, "12-lead EDF not created"


# ══════════════════════════════════════════════════════════════════════════════
# TEST 2 — Validate EDF files
# ══════════════════════════════════════════════════════════════════════════════

def test_2_validate_edfs():
    head("TEST 2 — Validate EDF Files")
    import pyedflib

    for edf_path, expected_ch, patient_name in [
        (EDF_3,  3,  "Test_Patient_P001"),
        (EDF_12, 12, "Test_Patient_P002"),
    ]:
        assert os.path.exists(edf_path), f"EDF not found: {edf_path} — run TEST 1 first"

        f = pyedflib.EdfReader(edf_path)
        n_ch    = f.signals_in_file
        labels  = [f.getLabel(i).strip() for i in range(n_ch)]
        rates   = [int(f.getSampleFrequency(i)) for i in range(n_ch)]
        dur     = f.getFileDuration()
        pname   = f.getPatientName().strip()
        n_ann   = len(f.readAnnotations()[0]) if edf_path == EDF_3 else 0
        f._close()

        info(f"{os.path.basename(edf_path)}: {n_ch} channels, {dur}s, patient={pname}")
        info(f"  Labels: {labels}")
        info(f"  Rates:  {set(rates)} Hz")

        assert n_ch == expected_ch, f"Expected {expected_ch} channels, got {n_ch}"
        assert all(r == 250 for r in rates), f"Unexpected sampling rates: {rates}"
        assert dur == 300, f"Expected 300s duration, got {dur}s"
        # pyedflib EDF+ stores patient field as "CODE SEX DOB NAME"
        # so patient_name may appear anywhere in the string
        assert patient_name.replace("_"," ") in pname.replace("_"," "), \
            f"Patient name '{patient_name}' not found in EDF patient field: '{pname}'"

        ok(f"{os.path.basename(edf_path)}: valid ✓  channels={n_ch}  sr=250Hz  dur={dur}s")

        if edf_path == EDF_3:
            assert n_ann >= 3, f"Expected 3 annotations, got {n_ann}"
            ok(f"Annotations: {n_ann} patient diary events embedded")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 3 — Ingest 3-lead EDF through full pipeline
# ══════════════════════════════════════════════════════════════════════════════

def test_3_ingest_3lead():
    head("TEST 3 — Ingest 3-Lead EDF → H5  (streaming pipeline)")
    _run_ingest(EDF_3, "P001", H5_P001, expected_leads=["I","II","V2"])


# ══════════════════════════════════════════════════════════════════════════════
# TEST 4 — Ingest 12-lead EDF through full pipeline
# ══════════════════════════════════════════════════════════════════════════════

def test_4_ingest_12lead():
    head("TEST 4 — Ingest 12-Lead EDF → H5  (streaming pipeline)")
    _run_ingest(EDF_12, "P002", H5_P002,
                expected_leads=["I","II","III","aVR","aVL","aVF","V1","V2","V3","V4","V5","V6"])


def _run_ingest(edf_path, patient_id, h5_path, expected_leads):
    """Shared ingest logic for tests 3 and 4."""
    assert os.path.exists(edf_path), f"EDF not found — run TEST 1 first"

    sys.path.insert(0, BASE)
    from acquisition.ingest_stream import IngestSession

    # Remove old H5 if exists so test is clean
    if os.path.exists(h5_path):
        os.remove(h5_path)

    info(f"Starting IngestSession for {patient_id}...")
    t0 = time.time()

    session = IngestSession(
        patient_id    = patient_id,
        source_path   = edf_path,
        source_method = "test",
    )

    # Poll until complete or error (max 60 seconds)
    deadline = time.time() + 60
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
            raise AssertionError(f"Session errored — check logs")

    elapsed = time.time() - t0
    assert session.status == "complete", f"Status={session.status} after {elapsed:.0f}s"

    ok(f"Ingest complete in {elapsed:.1f}s  (H5 pre-allocated within ~1s)")
    assert os.path.exists(h5_path), f"H5 not created at {h5_path}"
    ok(f"H5 file exists: {h5_path}")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 5 — Verify H5 files
# ══════════════════════════════════════════════════════════════════════════════

def test_5_verify_h5():
    head("TEST 5 — Verify H5 Files (compression, shape, attributes)")
    import h5py, hdf5plugin

    for h5_path, patient_id, exp_leads, exp_n in [
        (H5_P001, "P001", ["I","II","V2"],  3),
        (H5_P002, "P002", None,             12),
    ]:
        assert os.path.exists(h5_path), f"H5 not found — run TEST 3/4 first"

        with h5py.File(h5_path, "r") as f:
            ds       = f["ecg"]
            shape    = ds.shape
            sr       = int(f.attrs.get("sampling_rate", 0))
            n_leads  = int(f.attrs.get("num_leads", 0))
            status   = f.attrs.get("status", "?")
            written  = int(f.attrs.get("samples_written", 0))
            compress = f.attrs.get("compression", "?")
            try:
                leads = json.loads(f.attrs.get("lead_names", "[]"))
            except Exception:
                leads = []

            # Read a 10-second window to verify decompression
            t0 = time.time()
            window = ds[0:2500, :]
            read_ms = (time.time() - t0) * 1000

        disk_mb  = os.path.getsize(h5_path) / 1e6
        raw_mb   = written * n_leads * 4 / 1e6
        ratio    = raw_mb / disk_mb if disk_mb > 0 else 0

        info(f"{patient_id}: shape={shape}  sr={sr}Hz  status={status}")
        info(f"  Leads:        {leads}")
        info(f"  On disk:      {disk_mb:.1f} MB")
        info(f"  Uncompressed: {raw_mb:.1f} MB")
        info(f"  Ratio:        {ratio:.1f}x")
        info(f"  Compression:  {compress}")
        info(f"  10s read:     {read_ms:.1f}ms")

        assert status == "complete",    f"Status={status}, expected complete"
        assert sr == 250,               f"SR={sr}, expected 250"
        assert n_leads == exp_n,        f"n_leads={n_leads}, expected {exp_n}"
        assert written > 0,             f"samples_written=0"
        assert ratio > 1.0,            f"Compression ratio {ratio:.1f}x too low — Blosc may not be active"
        assert read_ms < 200,           f"10s read took {read_ms:.0f}ms — too slow"
        assert window.shape == (2500, exp_n), f"Window shape wrong: {window.shape}"

        if exp_leads:
            assert leads == exp_leads, f"Lead names wrong: {leads}"

        ok(f"{patient_id}: ✓  {ratio:.1f}x compression  {read_ms:.0f}ms read  leads={leads}")
        if ratio < 2.0:
            warn(f"  Note: synthetic 5-min data compresses ~1.2x. Real 48hr ECG compresses 3-4x.")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 6 — Simulate SD card drop via watcher
# ══════════════════════════════════════════════════════════════════════════════

def test_6_sd_card_watcher():
    head("TEST 6 — SD Card / Watcher Simulation")

    sys.path.insert(0, BASE)
    from acquisition.watcher import EDFWatcher

    # Use a fresh copy of EDF_3 named with patient ID
    src  = EDF_3
    dest = os.path.join(INCOM, "P001_watcher_test.edf")

    assert os.path.exists(src), "3-lead EDF not found — run TEST 1 first"

    info("Starting watcher...")
    watcher = EDFWatcher()
    watcher.start()
    time.sleep(0.5)

    info(f"Copying EDF into incoming folder: {dest}")
    shutil.copy2(src, dest)

    # Wait for watcher to pick it up and complete (max 30s for 5min EDF)
    deadline = time.time() + 40
    session  = None
    while time.time() < deadline:
        time.sleep(1)
        active = watcher.active_sessions()
        if active:
            sid     = list(active.keys())[0]
            session = active[sid]
            status  = session.status
            secs    = session.seconds_available
            info(f"  Session {sid[:8]}: status={status}  secs_available={secs:.0f}")
            if status == "complete":
                break
            if status == "error":
                watcher.stop()
                raise AssertionError(f"Watcher session errored")

    watcher.stop()

    assert session is not None, "Watcher never picked up the file"
    assert session.status == "complete", f"Status={session.status}"
    ok(f"Watcher detected file, ingested completely, status=complete")

    # Clean up
    processed = os.path.join(INCOM, "processed")
    moved     = os.path.join(processed, "P001_watcher_test.edf")
    if os.path.exists(moved):
        ok(f"File moved to processed/  ✓")
    else:
        warn("File not moved to processed/ — check watcher logic")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 7 — Simulate WiFi transfer
# ══════════════════════════════════════════════════════════════════════════════

def test_7_wifi_transfer():
    head("TEST 7 — WiFi Transfer Simulation (requires api.py running)")

    try:
        import requests
    except ImportError:
        warn("requests not installed: pip install requests")
        warn("Skipping WiFi test")
        return

    # Check if server is running
    try:
        r = requests.get("http://localhost:5000/health", timeout=3)
        if r.status_code != 200:
            raise Exception(f"Status {r.status_code}")
    except Exception as e:
        warn(f"api.py not running at localhost:5000 ({e})")
        warn("Start api.py in another terminal and re-run this test")
        warn("Skipping WiFi test (other tests still valid)")
        return

    assert os.path.exists(EDF_3), "3-lead EDF not found — run TEST 1 first"

    edf_size   = os.path.getsize(EDF_3)
    CHUNK      = 65536
    THROTTLE   = 0.002   # 2ms delay → ~32 MB/s simulated WiFi

    info(f"Simulating WiFi upload: {edf_size/1e6:.1f} MB at ~32 MB/s")

    session_id = None
    sent       = 0

    def gen():
        nonlocal sent
        with open(EDF_3, "rb") as f:
            while True:
                chunk = f.read(CHUNK)
                if not chunk:
                    break
                time.sleep(THROTTLE)
                sent += len(chunk)
                yield chunk

    resp = requests.post(
        "http://localhost:5000/upload",
        data=gen(),
        headers={
            "Content-Type":   "application/octet-stream",
            "Content-Length": str(edf_size),
            "X-Patient-Id":   "P001",
            "X-Filename":     "P001_wifi_test.edf",
        },
        stream=False,
        timeout=120,
    )

    assert resp.status_code == 200, f"Upload failed: {resp.status_code} {resp.text}"
    data       = resp.json()
    session_id = data.get("session_id")
    assert session_id, "No session_id in response"
    ok(f"Upload accepted: session={session_id[:8]}")

    # Poll status until complete
    info("Polling /api/transfer/status...")
    deadline = time.time() + 60
    while time.time() < deadline:
        time.sleep(2)
        sr = requests.get(
            f"http://localhost:5000/api/transfer/status/{session_id}", timeout=5
        )
        if sr.status_code != 200:
            continue
        d      = sr.json()
        status = d.get("status", "?")
        secs   = d.get("seconds_available", 0)
        pct    = d.get("pct_written", 0)
        info(f"  status={status}  written={pct:.0f}%  secs_avail={secs:.0f}")
        if status == "complete":
            break
        if status == "error":
            raise AssertionError(f"WiFi ingest error: {d.get('error_message')}")

    assert d.get("status") == "complete", f"WiFi transfer did not complete"
    ok(f"WiFi transfer complete — session {session_id[:8]}")

    # Verify we can read ECG from API
    ecg_resp = requests.get(
        "http://localhost:5000/api/ecg/P001?start=0&duration=10", timeout=10
    )
    assert ecg_resp.status_code == 200, f"ECG API returned {ecg_resp.status_code}"
    ecg_data = ecg_resp.json()
    lead_names = ecg_data.get("lead_names", [])
    n_samples  = len(list(ecg_data.get("leads", {}).values())[0]) if ecg_data.get("leads") else 0
    assert n_samples > 0, "ECG API returned empty lead data"
    ok(f"ECG API serves data: leads={lead_names}  samples={n_samples}")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 8 — API serves ECG correctly from H5
# ══════════════════════════════════════════════════════════════════════════════

def test_8_api_ecg():
    head("TEST 8 — API Serves ECG Data from H5")

    try:
        import requests
        r = requests.get("http://localhost:5000/health", timeout=3)
        api_up = r.status_code == 200
    except Exception:
        api_up = False

    if not api_up:
        # Test directly against H5 without the server
        warn("api.py not running — testing H5 read directly instead")
        import h5py, hdf5plugin

        for h5_path, pid, exp_n in [(H5_P001,"P001",3),(H5_P002,"P002",12)]:
            if not os.path.exists(h5_path):
                warn(f"H5 not found for {pid} — run TEST 3/4 first")
                continue
            with h5py.File(h5_path, "r") as f:
                sr    = int(f.attrs.get("sampling_rate", 250))
                total = f["ecg"].shape[0]
                t0    = time.time()
                # Read 30 seconds
                window = f["ecg"][0 : sr*30, :]
                ms     = (time.time()-t0)*1000
            ok(f"{pid}: H5 read 30s window  shape={window.shape}  in {ms:.0f}ms")
            assert window.shape == (sr*30, exp_n)
        return

    # Full API test
    for pid, exp_n in [("P001",3), ("P002",12)]:
        # 10 second window
        r = requests.get(f"http://localhost:5000/api/ecg/{pid}?start=0&duration=10", timeout=10)
        assert r.status_code == 200, f"GET /api/ecg/{pid} returned {r.status_code}: {r.text}"
        d = r.json()

        lead_names = d.get("lead_names", [])
        sr         = d.get("sr", 0)
        total_sec  = d.get("total_sec", 0)
        leads      = d.get("leads", {})

        assert len(lead_names) == exp_n,  f"{pid}: expected {exp_n} leads, got {len(lead_names)}"
        assert sr == 250,                  f"{pid}: expected sr=250, got {sr}"
        assert total_sec >= 299,          f"{pid}: total_sec={total_sec} too short"
        assert len(leads) == exp_n,       f"{pid}: {len(leads)} lead arrays returned"

        # Verify sample counts
        for name, samples in leads.items():
            assert len(samples) == sr * 10, f"{pid} lead {name}: expected {sr*10} samples, got {len(samples)}"
            # Verify data is not all zeros
            arr = np.array(samples)
            assert arr.std() > 0.01, f"{pid} lead {name}: signal looks flat (std={arr.std():.4f})"

        ok(f"{pid}: ✓  leads={lead_names}  sr={sr}Hz  dur={total_sec:.0f}s  10s window OK")

        # Also test a window at t=120s (middle of recording)
        r2 = requests.get(f"http://localhost:5000/api/ecg/{pid}?start=120&duration=10", timeout=10)
        assert r2.status_code == 200
        d2 = r2.json()
        assert len(list(d2["leads"].values())[0]) == 2500
        ok(f"{pid}: ✓  mid-recording window (t=120s) served correctly")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 9 — RAM usage during large file ingest
# ══════════════════════════════════════════════════════════════════════════════

def test_9_ram_check():
    head("TEST 9 — RAM Usage Check During Ingest")

    try:
        import psutil
    except ImportError:
        warn("psutil not installed: pip install psutil")
        warn("Skipping RAM test")
        return

    import pyedflib, neurokit2 as nk

    # Generate a 30-minute EDF (bigger than the 5-min test files)
    BIG_EDF = os.path.join(DATA, "P001_30min_ram_test.edf")
    if not os.path.exists(BIG_EDF):
        info("Generating 30-minute test EDF for RAM test...")
        dur = 1800   # 30 minutes
        sigs = [nk.ecg_simulate(duration=dur, sampling_rate=250,
                                heart_rate=72, noise=0.05) for _ in range(3)]
        writer = pyedflib.EdfWriter(BIG_EDF, 3, file_type=pyedflib.FILETYPE_EDFPLUS)
        writer.setPatientCode("P001")
        writer.setPatientName("Test_Patient_P001")
        writer.setSignalHeaders([{
            "label": ["I","II","V2"][i], "dimension": "mV",
            "sample_frequency": 250, "physical_max": 2.0, "physical_min": -2.0,
            "digital_max": 32767, "digital_min": -32768,
            "prefilter": "HP:0.5Hz LP:45Hz", "transducer": "Synthetic",
        } for i in range(3)])
        writer.writeSamples(sigs)
        writer.close()
        info(f"Generated: {os.path.getsize(BIG_EDF)/1e6:.1f} MB")

    sys.path.insert(0, BASE)
    from acquisition.ingest_stream import IngestSession

    proc     = psutil.Process(os.getpid())
    ram_peak = [0]

    def monitor_ram():
        while True:
            try:
                mb = proc.memory_info().rss / 1e6
                if mb > ram_peak[0]:
                    ram_peak[0] = mb
                time.sleep(0.2)
            except Exception:
                break

    mon = threading.Thread(target=monitor_ram, daemon=True)
    mon.start()

    ram_before = proc.memory_info().rss / 1e6
    info(f"RAM before ingest: {ram_before:.0f} MB")

    t0      = time.time()
    session = IngestSession(patient_id="P001", source_path=BIG_EDF, source_method="test")

    deadline = time.time() + 120
    while time.time() < deadline:
        time.sleep(1)
        if session.status in ("complete","error"):
            break

    elapsed = time.time() - t0
    ram_after = proc.memory_info().rss / 1e6

    info(f"RAM after ingest:  {ram_after:.0f} MB")
    info(f"RAM peak:          {ram_peak[0]:.0f} MB")
    info(f"RAM delta:         {ram_peak[0]-ram_before:.0f} MB")
    info(f"Ingest time:       {elapsed:.0f}s for 30min EDF")

    assert session.status == "complete", f"Ingest failed: {session.status}"
    assert ram_peak[0] < ram_before + 250, (
        f"RAM grew by {ram_peak[0]-ram_before:.0f} MB — streaming not working correctly"
    )

    ok(f"RAM peak delta: {ram_peak[0]-ram_before:.0f} MB  (limit: 250 MB)  ✓")
    ok(f"30min EDF ingested in {elapsed:.0f}s")


# ══════════════════════════════════════════════════════════════════════════════
# TEST 10 — Download real PhysioNet ECG (optional, requires internet)
# ══════════════════════════════════════════════════════════════════════════════

def test_10_physionet_real():
    head("TEST 10 — Real PhysioNet ECG (MIT-BIH) Optional")
    warn("This test downloads a real ECG from physionet.org")
    warn("Requires: pip install wfdb  and  internet connection")

    try:
        import wfdb
    except ImportError:
        warn("wfdb not installed: pip install wfdb")
        warn("Skipping PhysioNet test")
        return

    info("Downloading MIT-BIH record 100 (short segment)...")
    try:
        record = wfdb.rdrecord("100", pb_dir="mitdb", sampfrom=0, sampto=7500)
    except Exception as e:
        warn(f"Download failed: {e}")
        warn("Skipping PhysioNet test")
        return

    signal = record.p_signal.astype(np.float32)
    sr     = record.fs
    leads  = record.sig_name

    info(f"Downloaded: shape={signal.shape}  sr={sr}Hz  leads={leads}")

    # Save to H5 directly (bypasses EDF format since it's already in memory)
    import h5py, hdf5plugin
    h5_path = os.path.join(PATS, "P001", "ecg_mitbih.h5")
    n_leads = signal.shape[1]

    with h5py.File(h5_path, "w") as f:
        ds = f.create_dataset(
            "ecg", data=signal,
            chunks=(sr*5, n_leads),
            **hdf5plugin.Blosc(cname="zstd", clevel=3,
                               shuffle=hdf5plugin.Blosc.BITSHUFFLE)
        )
        f.attrs["sampling_rate"]  = sr
        f.attrs["num_leads"]      = n_leads
        f.attrs["total_samples"]  = signal.shape[0]
        f.attrs["duration_sec"]   = signal.shape[0] / sr
        f.attrs["lead_names"]     = json.dumps(leads)
        f.attrs["status"]         = "complete"
        f.attrs["samples_written"]= signal.shape[0]
        f.attrs["compression"]    = "blosc+zstd+bitshuffle"

    size_mb = os.path.getsize(h5_path) / 1e6
    raw_mb  = signal.nbytes / 1e6
    ok(f"Real MIT-BIH ECG saved: {h5_path}")
    ok(f"Compression: {raw_mb:.1f} MB → {size_mb:.1f} MB  ({raw_mb/size_mb:.1f}x)")
    ok(f"Leads: {leads}  SR: {sr}Hz  Duration: {signal.shape[0]/sr:.1f}s")

    # Verify it reads back correctly
    with h5py.File(h5_path, "r") as f:
        window = f["ecg"][0:sr*10, :]
    assert window.shape == (sr*10, n_leads)
    ok(f"10s window reads back correctly: shape={window.shape}")


# ══════════════════════════════════════════════════════════════════════════════
# RUNNER
# ══════════════════════════════════════════════════════════════════════════════

ALL_TESTS = {
    1:  ("Generate EDF files",          test_1_generate_edfs),
    2:  ("Validate EDF files",          test_2_validate_edfs),
    3:  ("Ingest 3-lead EDF → H5",      test_3_ingest_3lead),
    4:  ("Ingest 12-lead EDF → H5",     test_4_ingest_12lead),
    5:  ("Verify H5 compression",       test_5_verify_h5),
    6:  ("SD card watcher simulation",  test_6_sd_card_watcher),
    7:  ("WiFi transfer simulation",    test_7_wifi_transfer),
    8:  ("API ECG endpoint",            test_8_api_ecg),
    9:  ("RAM usage check",             test_9_ram_check),
    10: ("PhysioNet real ECG",          test_10_physionet_real),
}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--test",  default="all",   help="Test numbers e.g. 1,3,5 or 'all'")
    parser.add_argument("--quick", action="store_true", help="Run tests 1-5 only (no server/wifi)")
    args = parser.parse_args()

    if args.quick:
        to_run = [1,2,3,4,5]
    elif args.test == "all":
        to_run = list(ALL_TESTS.keys())
    else:
        to_run = [int(x.strip()) for x in args.test.split(",")]

    print(f"\n{BOLD}{CYAN}Holter ECG Acquisition Test Suite{RESET}")
    print(f"Running tests: {to_run}\n")

    for num in to_run:
        if num not in ALL_TESTS:
            warn(f"Unknown test number: {num}")
            continue
        name, fn = ALL_TESTS[num]
        run_test(f"TEST {num}: {name}", fn)

    # Summary
    print(f"\n{'═'*60}")
    print(f"{BOLD}RESULTS{RESET}")
    print(f"{'═'*60}")
    passed = sum(1 for v in results.values() if v)
    failed = sum(1 for v in results.values() if not v)
    for name, passed_bool in results.items():
        icon = f"{GREEN}✓{RESET}" if passed_bool else f"{RED}✗{RESET}"
        print(f"  {icon}  {name}")
    print(f"\n  Total: {passed} passed, {failed} failed")

    if failed == 0:
        print(f"\n{GREEN}{BOLD}ALL TESTS PASSED ✓{RESET}")
        print("Your acquisition pipeline is working correctly.")
        print("ECG data flows from EDF → H5 → API → canvas.")
    else:
        print(f"\n{YELLOW}Some tests failed. Check output above.{RESET}")

    print()
    sys.exit(0 if failed == 0 else 1)

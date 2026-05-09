# Data Acquisition — Integration Guide

Complete guide for wiring the acquisition module into your existing v7 codebase,
testing it without a real device, and understanding every moving part.

---

## 1. File Placement

Copy these files into your project exactly as shown:

```
holter-ecg/
├── backend/
│   ├── api.py                          ← MODIFY (3 edits, see Section 3)
│   ├── requirements_acquisition.txt    ← NEW: pip install this
│   └── acquisition/
│       ├── __init__.py                 ← NEW (empty file)
│       ├── progress_store.py           ← NEW: SQLite session tracker
│       ├── edf_stream_parser.py        ← NEW: incremental EDF parser
│       ├── h5_stream_writer.py         ← NEW: Blosc H5 writer
│       ├── ingest_stream.py            ← NEW: 3-thread pipeline controller
│       ├── watcher.py                  ← NEW: folder monitor
│       ├── wifi_receiver.py            ← NEW: Flask upload blueprint
│       ├── simulate_device.py          ← NEW: test harness
│       └── api_acquisition_patch.py    ← NEW: routes to add to api.py
│
└── frontend/src/
    ├── hooks/
    │   └── useIngestProgress.js        ← NEW: progress poller
    ├── components/
    │   └── IngestProgress.jsx          ← NEW: progress bar component
    └── pages/
        ├── DeviceConnect.jsx           ← NEW: 4-tab acquisition UI
        └── App.jsx                     ← MODIFY (2 edits, see Section 4)
```

---

## 2. Install Dependencies

```bash
cd holter-ecg/backend
pip install -r requirements_acquisition.txt
```

Verify Blosc is working:
```python
import hdf5plugin, h5py
print("Blosc OK")
```

---

## 3. Edit backend/api.py — 3 Changes

### Change 1: Add imports at the top (after existing imports)

```python
import hdf5plugin                          # MUST be imported before any H5 read
import socket
from acquisition.wifi_receiver  import wifi_bp
from acquisition.progress_store import get as ps_get, list_active, list_recent
from acquisition.watcher        import run_watcher
```

### Change 2: Register blueprint (after app = Flask(__name__))

```python
app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})
app.register_blueprint(wifi_bp)            # ← ADD THIS LINE
```

### Change 3: Add routes before  if __name__ == "__main__":

```python
@app.get("/api/transfer/status/<session_id>")
def get_transfer_status(session_id):
    session = ps_get(session_id)
    if not session:
        abort(404, f"Session {session_id} not found")
    return jsonify(session)


@app.get("/api/transfer/active")
def get_active_transfers():
    return jsonify(list_active())


@app.get("/api/transfer/recent")
def get_recent_transfers():
    return jsonify(list_recent(limit=20))


@app.get("/api/network/ip")
def get_network_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except Exception:
        ip = "127.0.0.1"
    return jsonify({"ip": ip, "port": PORT,
                    "upload_url": f"http://{ip}:{PORT}/upload"})
```

### Change 4: Start watcher in __main__ block

```python
if __name__ == "__main__":
    initialize_database()
    run_watcher()                          # ← ADD THIS LINE
    log.info("EDF folder watcher started")
    h5_files = glob.glob(os.path.join(DATA_DIR, "*.h5"))
    if h5_files:
        upsert_patient_files(DATA_DIR, h5_files)
    app.run(host="0.0.0.0", port=PORT, debug=False)
```

---

## 4. Edit frontend/src/App.jsx — 2 Changes

### Change 1: Import DeviceConnect

```jsx
import DeviceConnect from "./pages/DeviceConnect";
```

### Change 2: Add "Connect" tab to the navigation bar

In the tab bar section (near the Records and Settings tabs), add:

```jsx
{/* Device connect tab */}
<div
  onClick={() => setActiveTab("connect")}
  style={{
    padding: "0 16px", height: 36,
    display: "flex", alignItems: "center", cursor: "pointer",
    borderRight: "1px solid #181818",
    borderBottom: activeTab === "connect"
      ? `2px solid ${tokens.accent}` : "2px solid transparent",
    background: activeTab === "connect" ? tokens.surface2 : "transparent",
  }}
>
  <span style={{ fontFamily: "'Share Tech Mono',monospace", fontSize: 11,
    color: activeTab === "connect" ? tokens.accent : tokens.textMuted }}>
    📥 Connect
  </span>
</div>
```

### Change 3: Add DeviceConnect page to the page switcher

In the page content section (near where RecordsPage and SettingsPage are rendered):

```jsx
{/* Device connect page */}
{activeTab === "connect" && (
  <DeviceConnect onOpenPatient={openPatient} />
)}
```

---

## 5. Verify the wiring is correct

Start the backend:
```bash
cd backend
python api.py
```

You should see:
```
INFO  EDF folder watcher started
INFO  Watching .../data/incoming/ for .edf files
INFO  ECG API → http://localhost:5000
```

Test the new endpoints:
```bash
curl http://localhost:5000/api/transfer/active
# → []

curl http://localhost:5000/api/network/ip
# → {"ip": "192.168.x.x", "port": 5000, "upload_url": "http://192.168.x.x:5000/upload"}
```

---

## 6. Testing Without a Real Device

### Step 1 — Generate a test EDF

```bash
cd backend
python acquisition/simulate_device.py --generate --patient P001 --duration 300
```

This creates `data/P001_test_300s.edf` (~8 MB for 5 minutes, 3-lead, 250Hz).

For a larger test (closer to real device size):
```bash
python acquisition/simulate_device.py --generate --patient P001 --duration 3600
# → 1-hour file, ~60 MB
```

### Step 2 — Test SD card / file import (fastest test, start here)

```bash
python acquisition/simulate_device.py --mode sd --edf data/P001_test_300s.edf --patient P001
```

Watch the watcher terminal. You should see:
```
INFO  [watcher] Detected: P001_P001_test_300s.edf
INFO  [watcher] Starting ingest: P001_P001_test_300s.edf → patient P001
INFO  [T2-parser] Header parsed: leads=['I', 'II', 'V2'] sr=250Hz duration=0.08hr
INFO  [H5Writer] Pre-allocating .../data/patients/P001/ecg.h5 shape=(75000, 3)
INFO  [H5Writer] Pre-allocation done in <1s — API can serve now
INFO  [T3-writer] Complete. 0.08hr written. Session: xxxxxxxx
```

Then open the browser and verify ECG renders.

### Step 3 — Test WiFi transfer (tests streaming endpoint)

```bash
# Terminal 1: backend running
python api.py

# Terminal 2: simulate device pushing over WiFi at 6 MB/s
python acquisition/simulate_device.py --mode wifi --edf data/P001_test_300s.edf --patient P001 --speed 6
```

Watch the progress bar in the terminal. After ~10 seconds check the browser — ECG should appear before the transfer completes (for larger files).

### Step 4 — Test with a large file (2GB stress test)

```bash
# Generate full 48hr EDF from your existing H5
python acquisition/simulate_device.py --generate --patient P001 --duration 172800
# This takes 2-3 minutes to generate

# Then transfer it at 10 MB/s WiFi speed
python acquisition/simulate_device.py --mode wifi \
  --edf data/P001_test_172800s.edf \
  --patient P001 \
  --speed 10
```

While running, in another terminal monitor RAM:
```bash
# Windows
tasklist /fi "imagename eq python.exe"

# Linux/Mac
ps aux | grep python
```

RAM should stay under 200 MB throughout the entire transfer.

### Step 5 — Check Blosc compression ratio

```bash
python -c "
import h5py, hdf5plugin, os, json
path = 'data/patients/P001/ecg.h5'
with h5py.File(path, 'r') as f:
    ds       = f['ecg']
    written  = int(f.attrs.get('samples_written', ds.shape[0]))
    n_leads  = ds.shape[1]
    raw_mb   = written * n_leads * 4 / 1e6
    disk_mb  = os.path.getsize(path) / 1e6
    leads    = json.loads(f.attrs.get('lead_names', '[]'))
    sr       = int(f.attrs.get('sampling_rate', 250))
    print(f'Shape:        {ds.shape}')
    print(f'Leads:        {leads}')
    print(f'Duration:     {written/sr/3600:.2f} hours')
    print(f'Uncompressed: {raw_mb:.1f} MB')
    print(f'On disk:      {disk_mb:.1f} MB')
    print(f'Ratio:        {raw_mb/disk_mb:.1f}x')
    print(f'Compression:  {f.attrs.get(\"compression\", \"unknown\")}')
    print(f'Status:       {f.attrs.get(\"status\", \"unknown\")}')
"
```

Expected output for 5-min 3-lead test file:
```
Shape:        (75000, 3)
Leads:        ['I', 'II', 'V2']
Duration:     0.08 hours
Uncompressed: 0.9 MB
On disk:      0.3 MB
Ratio:        3.0x
Compression:  blosc+zstd+bitshuffle
Status:       complete
```

For 48-hour 3-lead:
```
Uncompressed: ~2600 MB
On disk:      ~650–800 MB
Ratio:        3.2–4.0x
```

### Step 6 — Test Bluetooth with your phone

1. Connect your phone to the laptop via USB cable first
2. Copy the test EDF to your phone:
   ```bash
   adb push data/P001_test_300s.edf /sdcard/P001_test_300s.edf
   ```
3. Disconnect USB, pair your phone with the laptop over Bluetooth
4. On phone: Files app → long-press `P001_test_300s.edf` → Share → Bluetooth → select laptop
5. Accept the file on your laptop
6. Move received file to `data/incoming/`:
   ```bash
   # Windows (received files usually go to Documents\Bluetooth Exchange)
   move "C:\Users\YourName\Documents\Bluetooth Exchange\P001_test_300s.edf" "data\incoming\P001_test_300s.edf"
   ```
7. Watcher detects it and starts ingestion automatically

---

## 7. How the UI Flow Works End-to-End

```
Doctor opens app
    → clicks "📥 Connect" tab in top nav
    → DeviceConnect.jsx shows 4 tabs

Doctor selects "SD / USB" tab
    → selects patient from dropdown
    → clicks "Select .edf file"
    → picks file from SD card drive
    → browser uploads it to POST /upload
    → wifi_receiver.py creates IngestSession
    → returns session_id immediately

IngestProgress.jsx appears in bottom-right corner
    → polls GET /api/transfer/status/<session_id> every 2s
    → shows dual progress bar (bytes received + samples written)

After ~10 seconds:
    → H5 pre-allocated, 60s of ECG written
    → useIngestProgress calls onReady(patientId)
    → "⚡ 60s of ECG ready to view" badge appears in progress bar
    → "View ECG →" button appears

Doctor clicks "View ECG →"
    → DeviceConnect calls onOpenPatient(patient)
    → App.jsx opens new ECG tab for this patient
    → ECGCanvas renders the first 60s of ECG immediately
    → Rest of recording continues loading in background

Transfer completes:
    → IngestProgress shows "✓ Full recording available — 48h 0m"
    → Doctor can scrub entire 48-hour recording
```

---

## 8. Data Directory Structure After Acquisition

```
holter-ecg/backend/data/
├── holter.db                           ← SQLite (patients + ingest_sessions tables)
├── incoming/
│   ├── P001_recording.edf              ← file here before processing
│   └── processed/
│       └── P001_recording.edf          ← moved here after ingest
└── patients/
    ├── P001/
    │   └── ecg.h5                      ← Blosc+Zstd+Bitshuffle compressed
    └── P002/
        └── ecg.h5
```

---

## 9. What Each File Does (One Line Each)

| File | Job |
|------|-----|
| `progress_store.py` | SQLite CRUD for ingest session state — status, bytes, samples, errors |
| `edf_stream_parser.py` | Accepts raw bytes via feed(), returns 5s float32 arrays via get_chunk() |
| `h5_stream_writer.py` | Pre-allocates H5 from header, appends Blosc-compressed chunks |
| `ingest_stream.py` | Creates the above two, runs 3 threads, exposes feed() for any transport |
| `watcher.py` | Monitors data/incoming/, calls IngestSession for any new .edf file |
| `wifi_receiver.py` | Flask blueprint — POST /upload streams bytes into IngestSession.feed() |
| `simulate_device.py` | CLI tool — simulates device over SD/WiFi/USB/BT for testing |
| `useIngestProgress.js` | React hook — polls /api/transfer/status/<id> every 2s |
| `IngestProgress.jsx` | React component — dual progress bar + ECG ready notification |
| `DeviceConnect.jsx` | React page — 4-tab UI for all acquisition methods |

---

## 10. When the Real Device Arrives

The only things that may need to change:

1. **Lead name mapping** in `edf_stream_parser.py → _LEAD_MAP`
   If the device labels channels as `ECG1`, `CH1`, or anything non-standard,
   add the mapping:
   ```python
   _LEAD_MAP["ECG1"] = "I"
   _LEAD_MAP["CH_A"] = "II"
   ```

2. **Sampling rate** in `ecgConstants.js`
   If device uses 256Hz instead of 250Hz:
   ```javascript
   export const SAMPLING_RATE = 256;  // update this
   ```
   The parser reads SR from the EDF header automatically, so the H5 will be correct.
   Only the JS constants need updating for the canvas timing.

3. **USB serial** — if device uses CDC serial instead of mass storage:
   Create `acquisition/usb_serial.py` after the firmware consultant confirms:
   - COM port name (e.g. COM3 or /dev/ttyUSB0)
   - Baud rate (e.g. 460800)
   - Command to request transfer (e.g. send "REQUEST\r\n", device responds with EDF bytes)
   
   Wire it to IngestSession exactly like the WiFi path:
   ```python
   session = IngestSession(patient_id="P001", source_method="usb")
   for chunk in serial_read_loop(port, baud):
       session.feed(chunk)
   ```

Everything else — parser, H5 writer, API, canvas — is completely unchanged.

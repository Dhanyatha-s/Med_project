"""
parser.py — EDF/EDF+ Holter File Parser
=========================================
Reads a 48-hour, 3-channel EDF file from the Holter device.
Converts it to HDF5 in the same format your existing api.py already reads.

How it fits into your pipeline:
    EDF file (from device)
        → parse_edf()            reads signal + metadata
        → save_to_h5()           saves in your existing HDF5 format
        → api.py already serves  no changes needed to API

Usage:
    python parser.py path/to/recording.edf patient_id

    e.g.
    python parser.py data/incoming/patient_002.edf P002

The output .h5 file goes into:  data/patients/<patient_id>/ecg.h5
"""
import h5py
import pyedflib
import os
import sys
import json
import hashlib
import numpy as np



# ── EDF METADATA ────────────────────────────────────────────────────────────

def read_edf_metadata(edf_path: str) -> dict:
    """
    Read all metadata from an EDF file without loading signal data.
    Returns a dict with everything you need before ingesting.
    """
    f = pyedflib.EdfReader(edf_path)

    metadata = {
        # Recording info
        "file_path":       edf_path,
        "file_size_mb":    round(os.path.getsize(edf_path) / 1024 / 1024, 2),

        # Patient info stored inside the EDF header
        "patient_name":    f.getPatientName().strip() or "Unknown",
        "patient_id":      f.getPatientCode().strip() or "Unknown",
        "patient_dob":     str(f.getBirthdate()),
        "patient_gender":  f.getSex().strip() or "Unknown",

        # Recording info
        "recording_start": str(f.getStartdatetime()),
        "duration_sec":    int(f.getFileDuration()),
        "duration_hours":  round(f.getFileDuration() / 3600, 2),

        # Signal info
        "n_channels":      int(f.signals_in_file),
        "channel_labels":  [f.getLabel(i).strip() for i in range(f.signals_in_file)],
        "sample_rates":    [int(f.getSampleFrequency(i)) for i in range(f.signals_in_file)],
        "physical_mins":   [f.getPhysicalMinimum(i) for i in range(f.signals_in_file)],
        "physical_maxs":   [f.getPhysicalMaximum(i) for i in range(f.signals_in_file)],
        "physical_dims":   [f.getPhysicalDimension(i).strip() for i in range(f.signals_in_file)],
        "prefilter":       [f.getPrefilter(i).strip() for i in range(f.signals_in_file)],

        # EDF+ annotations (patient event button presses, diary)
        "annotations":     [],
    }

    # Read EDF+ annotations if present (patient diary button presses)
    try:
        annotations_raw = f.readAnnotations()
        if annotations_raw and len(annotations_raw[0]) > 0:
            onsets, durations, labels = annotations_raw
            metadata["annotations"] = [
                {
                    "onset_sec":    float(onset),
                    "duration_sec": float(dur) if dur else 0.0,
                    "label":        str(label).strip(),
                }
                for onset, dur, label in zip(onsets, durations, labels)
            ]
    except Exception:
        pass  # Not all EDF files have annotations

    f._close()
    return metadata


# ── SIGNAL READING ───────────────────────────────────────────────────────────

def read_edf_signals(edf_path: str) -> tuple[np.ndarray, int, list[str]]:
    """
    Read all signal data from EDF file.
    Returns:
        signals      : np.ndarray shape (n_samples, n_channels), float32, in mV
        sampling_rate: int Hz (uses first channel — all channels should match)
        lead_names   : list of cleaned channel label strings
    """
    f = pyedflib.EdfReader(edf_path)
    n_channels = f.signals_in_file

    # Validate all channels have the same sampling rate
    rates = [int(f.getSampleFrequency(i)) for i in range(n_channels)]
    if len(set(rates)) > 1:
        print(f"WARNING: Channels have different sampling rates: {rates}")
        print(f"         Using rate of first channel: {rates[0]} Hz")
    sampling_rate = rates[0]

    # Read all channels
    n_samples = f.getNSamples()[0]  # samples in first channel
    signals = np.zeros((n_samples, n_channels), dtype=np.float32)

    print(f"  Reading {n_channels} channels × {n_samples:,} samples @ {sampling_rate} Hz...")

    for i in range(n_channels):
        ch_samples = f.readSignal(i)  # returns physical values (mV) — EDF stores ADC+gain
        # Align length in case channels differ slightly
        actual_len = min(len(ch_samples), n_samples)
        signals[:actual_len, i] = ch_samples[:actual_len].astype(np.float32)

    lead_names = [f.getLabel(i).strip() for i in range(n_channels)]
    lead_names = _clean_lead_names(lead_names)

    f._close()
    return signals, sampling_rate, lead_names


def _clean_lead_names(raw_names: list[str]) -> list[str]:
    """
    Normalise EDF channel labels to standard clinical lead names.
    EDF files from different manufacturers name leads differently.
    e.g. 'EDF Annotations', 'ECG1', 'Ch1', 'I', 'Lead I'
    """
    cleaned = []
    for name in raw_names:
        name = name.strip()

        # Skip annotation channels
        if "annotation" in name.lower() or name == "":
            cleaned.append(name)
            continue

        # Common manufacturer naming patterns → standard names
        mapping = {
            "ECG1": "I",   "ECG2": "II",  "ECG3": "III",
            "CH1":  "I",   "CH2":  "II",  "CH3":  "III",
            "LEAD1":"I",   "LEAD2":"II",  "LEAD3":"III",
            "C1":   "I",   "C2":   "II",  "C3":   "III",
        }
        upper = name.upper()
        cleaned.append(mapping.get(upper, name))

    return cleaned


# ── VALIDATION ───────────────────────────────────────────────────────────────

def validate_edf(edf_path: str) -> dict:
    """
    Run sanity checks on an EDF file before ingestion.
    Returns {"valid": True/False, "warnings": [], "errors": []}
    """
    result = {"valid": True, "warnings": [], "errors": []}

    if not os.path.exists(edf_path):
        result["errors"].append(f"File not found: {edf_path}")
        result["valid"] = False
        return result

    if not edf_path.lower().endswith((".edf", ".edf+")):
        result["warnings"].append("File extension is not .edf — attempting anyway")

    try:
        meta = read_edf_metadata(edf_path)
    except Exception as e:
        result["errors"].append(f"Cannot read EDF header: {e}")
        result["valid"] = False
        return result

    # Check channel count
    n_ch = meta["n_channels"]
    # EDF files sometimes include an 'EDF Annotations' channel
    signal_channels = [l for l in meta["channel_labels"] if "annotation" not in l.lower()]
    if len(signal_channels) < 1:
        result["errors"].append("No ECG signal channels found")
        result["valid"] = False
    elif len(signal_channels) not in [3, 12]:
        result["warnings"].append(
            f"Expected 3 or 12 signal channels, got {len(signal_channels)}: {signal_channels}"
        )

    # Check sampling rate (expected 250 or 256 Hz for Holter)
    for i, rate in enumerate(meta["sample_rates"]):
        if rate not in [250, 256, 500, 512, 1000]:
            result["warnings"].append(
                f"Channel {i} sampling rate {rate} Hz is unusual for Holter"
            )

    # Check duration (expect close to 48 hours)
    duration_hr = meta["duration_hours"]
    if duration_hr < 0.01:
        result["errors"].append(f"Recording too short: {duration_hr:.1f} hours")
        result["valid"] = False
    elif duration_hr < 23:
        result["warnings"].append(f"Recording shorter than expected: {duration_hr:.1f} hours")
    elif duration_hr > 50:
        result["warnings"].append(f"Recording unusually long: {duration_hr:.1f} hours")

    # Check physical units are mV
    for i, dim in enumerate(meta["physical_dims"]):
        if dim.lower() not in ["mv", "uv", "v", ""]:
            result["warnings"].append(f"Channel {i} unit '{dim}' — expected mV")

    return result


# ── HDF5 SAVE ────────────────────────────────────────────────────────────────

def save_to_h5(
    signals:       np.ndarray,
    sampling_rate: int,
    lead_names:    list[str],
    metadata:      dict,
    output_path:   str,
    chunk_sec:     int = 20,
) -> None:
    """
    Save parsed EDF signals to HDF5 in the EXACT format your api.py reads.
    No changes needed to api.py — this drops in as a new data source.

    HDF5 structure:
        /ecg                   dataset (n_samples, n_channels) float32
        /ecg.attrs             sampling_rate, num_leads, total_samples,
                               duration_sec, lead_names (JSON), patient_*
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    n_samples, n_channels = signals.shape
    chunk_samples = chunk_sec * sampling_rate  # 20s chunks for good streaming

    print(f"  Saving to HDF5: {output_path}")
    print(f"  Shape: {signals.shape} | SR: {sampling_rate} Hz | Chunks: {chunk_samples}")

    with h5py.File(output_path, "w") as f:
        # ── Main signal dataset ───────────────────────────────────────
        dset = f.create_dataset(
            "ecg",
            shape=signals.shape,
            dtype="float32",
            chunks=(chunk_samples, n_channels),
            compression="gzip",
            compression_opts=4,
        )

        # Write in chunks to keep RAM usage low
        for start in range(0, n_samples, chunk_samples):
            end = min(start + chunk_samples, n_samples)
            dset[start:end] = signals[start:end]

        # ── Metadata attributes — read by api.py ─────────────────────
        f.attrs["sampling_rate"]  = sampling_rate
        f.attrs["num_leads"]      = n_channels
        f.attrs["total_samples"]  = n_samples
        f.attrs["duration_sec"]   = float(n_samples / sampling_rate)
        f.attrs["lead_names"]     = json.dumps(lead_names)  # api.py reads this

        # Patient metadata from EDF header
        f.attrs["patient_name"]   = metadata.get("patient_name", "Unknown")
        f.attrs["patient_id"]     = metadata.get("patient_id", "Unknown")
        f.attrs["patient_gender"] = metadata.get("patient_gender", "Unknown")
        f.attrs["recording_start"]= metadata.get("recording_start", "")
        f.attrs["source_format"]  = "EDF"
        f.attrs["source_file"]    = os.path.basename(metadata.get("file_path", ""))

        # ── Annotations (patient diary) ───────────────────────────────
        annotations = metadata.get("annotations", [])
        if annotations:
            ann_data = np.array(
                [(a["onset_sec"], a["duration_sec"]) for a in annotations],
                dtype=[("onset_sec", "f8"), ("duration_sec", "f8")]
            )
            ann_labels = np.array(
                [a["label"].encode("utf-8") for a in annotations],
                dtype=h5py.special_dtype(vlen=str)
            )
            f.create_dataset("annotations/timestamps", data=ann_data)
            f.create_dataset("annotations/labels",     data=ann_labels)
            print(f"  Saved {len(annotations)} patient diary annotations")

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(f"  Done. File size: {size_mb:.1f} MB")


# ── FILE INTEGRITY ────────────────────────────────────────────────────────────

def compute_sha256(file_path: str) -> str:
    """Compute SHA256 hash of a file for integrity verification."""
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha.update(chunk)
    return sha.hexdigest()


# ── MAIN INGESTION FUNCTION ───────────────────────────────────────────────────

def ingest_edf(edf_path: str, patient_id: str, data_dir: str = None) -> dict:
    """
    Full ingestion pipeline:
        validate → read metadata → read signals → save HDF5

    Returns a result dict with paths and metadata for database insertion.
    Call this from your import IPC handler in Electron.
    """
    if data_dir is None:
        data_dir = os.path.join(os.path.dirname(__file__), "data")

    print(f"\n{'='*60}")
    print(f"  Ingesting EDF for patient: {patient_id}")
    print(f"  Source file: {edf_path}")
    print(f"{'='*60}")

    # Step 1: Validate
    print("\n[1/4] Validating EDF file...")
    validation = validate_edf(edf_path)

    for warn in validation["warnings"]:
        print(f"  WARNING: {warn}")
    for err in validation["errors"]:
        print(f"  ERROR:   {err}")

    if not validation["valid"]:
        return {
            "success":    False,
            "error":      "; ".join(validation["errors"]),
            "warnings":   validation["warnings"],
            "patient_id": patient_id,
        }

    # Step 2: Read metadata
    print("\n[2/4] Reading EDF metadata...")
    metadata = read_edf_metadata(edf_path)
    print(f"  Patient name  : {metadata['patient_name']}")
    print(f"  Recording start: {metadata['recording_start']}")
    print(f"  Duration       : {metadata['duration_hours']:.1f} hours")
    print(f"  Channels       : {metadata['n_channels']} → {metadata['channel_labels']}")
    print(f"  Sampling rates : {metadata['sample_rates']} Hz")
    print(f"  Annotations    : {len(metadata['annotations'])} diary events")

    # Step 3: Read signals
    print("\n[3/4] Reading signal data...")
    signals, sampling_rate, lead_names = read_edf_signals(edf_path)
    print(f"  Signal shape  : {signals.shape}")
    print(f"  Sampling rate : {sampling_rate} Hz")
    print(f"  Lead names    : {lead_names}")
    print(f"  Duration check: {signals.shape[0] / sampling_rate / 3600:.2f} hours")

    # Compute source file hash for integrity record
    sha256 = compute_sha256(edf_path)
    print(f"  SHA-256       : {sha256[:16]}...")

    # Step 4: Save to HDF5
    print("\n[4/4] Saving to HDF5...")
    patient_dir = os.path.join(data_dir, "patients", patient_id)
    h5_path     = os.path.join(patient_dir, "ecg.h5")
    save_to_h5(signals, sampling_rate, lead_names, metadata, h5_path)

    result = {
        "success":         True,
        "patient_id":      patient_id,
        "h5_path":         h5_path,
        "h5_filename":     f"patients/{patient_id}/ecg.h5",
        "source_edf":      edf_path,
        "source_sha256":   sha256,
        "sampling_rate":   sampling_rate,
        "n_channels":      signals.shape[1],
        "lead_names":      lead_names,
        "duration_hours":  metadata["duration_hours"],
        "recording_start": metadata["recording_start"],
        "patient_name":    metadata["patient_name"],
        "patient_gender":  metadata["patient_gender"],
        "annotations":     metadata["annotations"],
        "warnings":        validation["warnings"],
    }

    print(f"\n{'='*60}")
    print(f"  SUCCESS — patient {patient_id} ingested")
    print(f"  H5 ready at: {h5_path}")
    print(f"{'='*60}\n")

    return result


# ── SYNTHETIC EDF GENERATOR (for testing without real device) ─────────────────

def generate_synthetic_edf(output_path: str, duration_sec: int = 300, sampling_rate: int = 256):
    """
    Generate a synthetic 3-channel EDF file that mimics what the Holter device produces.
    Use this for testing until you have a real device recording.

    duration_sec = 300 → 5-minute test file (use 172800 for full 48hr)
    """
    try:
        import neurokit2 as nk
    except ImportError:
        print("Install neurokit2:  pip install neurokit2")
        return

    print(f"Generating synthetic EDF: {duration_sec}s @ {sampling_rate}Hz, 3 channels...")

    # Simulate 3 ECG channels with slightly different heart rates
    ch1 = nk.ecg_simulate(duration=duration_sec, sampling_rate=sampling_rate,
                           heart_rate=72, noise=0.05).astype(np.float32)
    ch2 = nk.ecg_simulate(duration=duration_sec, sampling_rate=sampling_rate,
                           heart_rate=72, noise=0.08).astype(np.float32)
    ch3 = nk.ecg_simulate(duration=duration_sec, sampling_rate=sampling_rate,
                           heart_rate=72, noise=0.06).astype(np.float32)

    n_samples = len(ch1)
    os.makedirs(os.path.dirname(output_path) if os.path.dirname(output_path) else ".", exist_ok=True)

    f = pyedflib.EdfWriter(output_path, 3, file_type=pyedflib.FILETYPE_EDFPLUS)

    # Set header
    f.setPatientName("TestPatient")
    f.setPatientCode("P_TEST")
    f.setSex("Male")

    # Set channel headers
    channel_info = []
    for label in ["I", "II", "V2"]:
        channel_info.append({
            "label":         label,
            "dimension":     "mV",
            "sample_frequency":   sampling_rate,
            "physical_max":  5.0,
            "physical_min": -5.0,
            "digital_max":   32767,
            "digital_min":  -32768,
            "prefilter":     "HP:0.5Hz LP:45Hz N:50Hz",
            "transducer":    "AgAgCl electrode",
        })
    f.setSignalHeaders(channel_info)

    # Write signals
    f.writeSamples([ch1, ch2, ch3])

    # Add some test annotations (patient button presses)
    f.writeAnnotation(60,  -1, "Patient event")       # at 1 minute
    f.writeAnnotation(120, -1, "Felt dizzy")           # at 2 minutes
    f.writeAnnotation(240, -1, "Chest discomfort")     # at 4 minutes

    f.close()

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    print(f"  Synthetic EDF written: {output_path} ({size_mb:.1f} MB)")
    print(f"  Channels: I, II, V2 | Duration: {duration_sec/60:.1f} min | SR: {sampling_rate} Hz")
    return output_path


# ── CLI ENTRY POINT ───────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) == 1:
        # No args: generate a synthetic EDF and ingest it for testing
        print("No arguments given. Running in TEST MODE:")
        print("  1. Generating synthetic 5-minute EDF file")
        print("  2. Ingesting it through the full pipeline")
        print("  3. Verifying the HDF5 output\n")

        test_edf = "data/test_synthetic.edf"
        generate_synthetic_edf(test_edf, duration_sec=300, sampling_rate=256)

        result = ingest_edf(test_edf, "P_TEST", data_dir="data")
        print("\nResult:")
        for k, v in result.items():
            if k not in ("annotations",):
                print(f"  {k}: {v}")

        # Verify the HDF5 can be read
        if result["success"]:
            print("\nVerifying HDF5 output...")
            with h5py.File(result["h5_path"], "r") as f:
                print(f"  ECG shape: {f['ecg'].shape}")
                print(f"  Lead names: {json.loads(f.attrs['lead_names'])}")
                print(f"  Sampling rate: {f.attrs['sampling_rate']} Hz")
                print(f"  Duration: {f.attrs['duration_sec']/3600:.2f} hours")
            print("\nAll good. The HDF5 is ready for api.py to serve.")

    elif len(sys.argv) == 3:
        # Normal usage: python parser.py recording.edf PATIENT_ID
        edf_path   = sys.argv[1]
        patient_id = sys.argv[2]
        result = ingest_edf(edf_path, patient_id)

        if not result["success"]:
            print(f"\nFailed: {result['error']}")
            sys.exit(1)

    elif len(sys.argv) == 2 and sys.argv[1] == "--generate":
        # Generate synthetic EDF only
        output = "data/test_synthetic.edf"
        generate_synthetic_edf(output, duration_sec=300, sampling_rate=256)

    else:
        print("Usage:")
        print("  python parser.py                        # test mode: generate + ingest synthetic")
        print("  python parser.py recording.edf P001     # ingest real EDF file")
        print("  python parser.py --generate             # generate synthetic EDF only")
        sys.exit(1)
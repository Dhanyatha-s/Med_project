#!/usr/bin/env python3
"""
diagnose_edf.py — run this on the PC, in the same folder as api.py.

It will:
  1. Check pyedflib is installed and print its version.
  2. Find the most recently received file in data/incoming/.
  3. Try to open it with EdfReader and print the header info that
     EDFStreamParser._do_parse() relies on.
  4. Try reading one chunk of signal data, exactly like the parser does.

Run with:
    python diagnose_edf.py
"""

import os
import glob
import sys

print("=" * 70)
print("STEP 1: pyedflib import")
print("=" * 70)
try:
    import pyedflib
    print(f"OK — pyedflib version: {getattr(pyedflib, '__version__', 'unknown')}")
except Exception as e:
    print(f"FAIL — pyedflib import error: {e}")
    sys.exit(1)

print()
print("=" * 70)
print("STEP 2: locate latest file in data/incoming/")
print("=" * 70)
incoming_dir = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "data", "incoming")
)
print(f"Looking in: {incoming_dir}")

files = glob.glob(os.path.join(incoming_dir, "*.edf")) + \
        glob.glob(os.path.join(incoming_dir, "wifi_*"))
files = sorted(set(files), key=os.path.getmtime, reverse=True)

if not files:
    print("FAIL — no files found in data/incoming/")
    print("       (file may have been cleaned up already, or wrong path)")
    sys.exit(1)

edf_path = files[0]
size_mb = os.path.getsize(edf_path) / 1e6
print(f"Found: {edf_path}  ({size_mb:.2f} MB)")

print()
print("=" * 70)
print("STEP 3: open with EdfReader")
print("=" * 70)
try:
    f = pyedflib.EdfReader(edf_path)
    print("OK — EdfReader opened successfully")
except Exception as e:
    print(f"FAIL — EdfReader could not open file: {e}")
    print()
    print("This means the EDF FILE ITSELF is malformed.")
    print("The bug is in generate_edf() / pyedflib.EdfWriter, not the server.")
    sys.exit(1)

print()
print("=" * 70)
print("STEP 4: read header fields")
print("=" * 70)
try:
    ns      = f.signals_in_file
    sr      = f.getSampleFrequency(0)
    n_rec   = f.datarecords_in_file
    rec_dur = f.datarecord_duration
    total   = f.getNSamples()[0]
    labels  = [f.getLabel(i).strip() for i in range(ns)]

    print(f"signals_in_file     = {ns}")
    print(f"labels              = {labels}")
    print(f"sample_frequency[0] = {sr}")
    print(f"datarecords_in_file = {n_rec}")
    print(f"datarecord_duration = {rec_dur}")
    print(f"total_samples[0]    = {total}")

    if rec_dur == 0 or rec_dur is None:
        print()
        print("!!! datarecord_duration is 0/None — this WILL cause a")
        print("    ZeroDivisionError or infinite loop in _do_parse()'s")
        print("    chunk-emission loop (records_per_chunk calculation).")

    if n_rec == 0:
        print()
        print("!!! datarecords_in_file is 0 — header parses, but the")
        print("    chunk loop will exit immediately with NO chunks ever")
        print("    sent to the writer (file would 'complete' with 0s data,")
        print("    not hang — so this alone doesn't explain a 60s timeout,")
        print("    but indicates the EDF was written without data records).")

except Exception as e:
    print(f"FAIL — error reading header fields: {e}")
    import traceback; traceback.print_exc()

print()
print("=" * 70)
print("STEP 5: read first signal chunk (mimics parser)")
print("=" * 70)
try:
    sig = f.readSignal(0, start=0, n=min(1280, total), digital=False)
    print(f"OK — read {len(sig)} samples from channel 0")
    print(f"first 5 values: {sig[:5]}")
except Exception as e:
    print(f"FAIL — readSignal error: {e}")
    import traceback; traceback.print_exc()

f._close()

print()
print("=" * 70)
print("DONE")
print("=" * 70)
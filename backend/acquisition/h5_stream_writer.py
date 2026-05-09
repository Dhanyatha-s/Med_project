"""
h5_stream_writer.py  —  Streaming HDF5 writer with Blosc+Zstd+Bitshuffle
─────────────────────────────────────────────────────────────────────────────
Receives float32 arrays from Thread 2 (EDF stream parser).
Writes them incrementally into an HDF5 file using Blosc compression.

Compression stack:
  Bitshuffle  — reorganises float32 bits so adjacent-sample bytes group together
                ECG is smooth → grouped bytes are highly repetitive
  Zstandard   — high-speed lossless compression on the bit-shuffled data
                clevel=3 is the sweet spot: strong ratio, fast enough for streaming

Chunk alignment:
  chunks=(sr*5, n_leads) matches exactly the 5-second arrays from the parser.
  Every append_chunk() call writes one complete HDF5 chunk.
  No partial-chunk read-modify-write cycles → maximum write throughput.

Pre-allocation:
  pre_allocate() creates the dataset with correct shape BEFORE any data arrives.
  This uses only H5 metadata — completes in <1 second for any file size.
  After pre_allocate() returns, the API can already serve the file.
  Unwritten regions return 0.0 (flat line on the ECG canvas).

IMPORTANT: import hdf5plugin must be called in any process that reads this H5.
           api.py must have 'import hdf5plugin' at the top.
"""

import os
import json
import logging
import threading
import numpy as np
import h5py
import hdf5plugin   # registers Blosc codec with h5py — required

log = logging.getLogger(__name__)

_DATA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "data")
)


class H5StreamWriter:

    def __init__(self, patient_id: str, session_id: str):
        self._patient_id  = patient_id
        self._session_id  = session_id
        self._h5_path     = None
        self._fh          = None
        self._dset        = None
        self._written     = 0       # samples written so far
        self._sr          = 250
        self._n_leads     = 0
        self._lock        = threading.Lock()
        self._ready       = threading.Event()   # set when pre_allocate() done

    # ── Public API ────────────────────────────────────────────────────────────

    def pre_allocate(self, header: dict) -> str:
        """
        Create the H5 file and dataset from parsed EDF header.
        Called by Thread 2 as soon as header_ready fires.
        Returns the H5 file path.

        This is a metadata-only operation — no signal data written yet.
        Completes in under 1 second regardless of recording duration.
        """
        self._sr      = header["sr"]
        self._n_leads = header["n_leads"]
        n_total       = header["total_samples"]
        lead_names    = header["lead_names"]
        chunk_samples = self._sr * 5   # 5-second chunks — MUST match parser output

        # Build output path
        patient_dir  = os.path.join(_DATA_DIR, "patients", self._patient_id)
        os.makedirs(patient_dir, exist_ok=True)
        self._h5_path = os.path.join(patient_dir, "ecg.h5")

        log.info(
            f"[H5Writer] Pre-allocating {self._h5_path}  "
            f"shape=({n_total}, {self._n_leads})  sr={self._sr}Hz  "
            f"leads={lead_names}"
        )

        with self._lock:
            self._fh = h5py.File(self._h5_path, "w")

            # ── Main ECG dataset ──────────────────────────────────────────────
            self._dset = self._fh.create_dataset(
                "ecg",
                shape    = (n_total, self._n_leads),
                maxshape = (None, self._n_leads),    # resizable if recording longer than declared
                dtype    = "float32",
                chunks   = (chunk_samples, self._n_leads),  # aligned with parser chunk size
                **hdf5plugin.Blosc(
                    cname   = "zstd",
                    clevel  = 3,
                    shuffle = hdf5plugin.Blosc.BITSHUFFLE,  # best for float32 ECG
                )
            )

            # ── Attributes — read by api.py ───────────────────────────────────
            self._fh.attrs["sampling_rate"]  = self._sr
            self._fh.attrs["num_leads"]      = self._n_leads
            self._fh.attrs["total_samples"]  = n_total
            self._fh.attrs["duration_sec"]   = float(n_total / self._sr)
            self._fh.attrs["lead_names"]     = json.dumps(lead_names)
            self._fh.attrs["patient_id"]     = self._patient_id
            self._fh.attrs["patient_name"]   = header.get("patient_name", "Unknown")
            self._fh.attrs["recording_start"]= f"{header.get('start_date','')} {header.get('start_time','')}"
            self._fh.attrs["source_format"]  = "EDF"
            self._fh.attrs["compression"]    = "blosc+zstd+bitshuffle"
            self._fh.attrs["status"]         = "receiving"   # updated to 'complete' on finalise()
            self._fh.attrs["samples_written"] = 0            # incremented on each chunk
            self._fh.attrs["session_id"]     = self._session_id
            self._fh.flush()

        self._ready.set()
        log.info(f"[H5Writer] Pre-allocation done in <1s — API can serve now")
        return self._h5_path

    def append_chunk(self, samples: np.ndarray) -> int:
        """
        Write one chunk of float32 samples to H5.
        samples.shape = (n_samples, n_leads)
        Returns total samples written after this call.

        Thread-safe — called only by Thread 3 but lock protects against
        concurrent reads from the API during hot reload scenarios.
        """
        if not self._ready.is_set():
            log.warning("[H5Writer] append_chunk called before pre_allocate — waiting")
            self._ready.wait(timeout=10)

        n = len(samples)

        with self._lock:
            end = self._written + n

            # Resize if EDF under-reported total_samples (some devices do this)
            if end > self._dset.shape[0]:
                self._dset.resize(end, axis=0)
                self._fh.attrs["total_samples"] = end
                log.debug(f"[H5Writer] Resized dataset to {end} samples")

            self._dset[self._written:end] = samples
            self._written = end
            self._fh.attrs["samples_written"] = self._written
            self._fh.flush()

        return self._written

    def finalise(self, status: str = "complete") -> None:
        """
        Mark recording complete and close file.
        Called by Thread 3 when parser.done is True.
        """
        with self._lock:
            if self._fh is None:
                return
            self._fh.attrs["status"]         = status
            self._fh.attrs["samples_written"] = self._written
            self._fh.flush()
            self._fh.close()
            self._fh  = None
            self._dset = None

        size_mb = os.path.getsize(self._h5_path) / 1e6
        uncompressed_mb = self._written * self._n_leads * 4 / 1e6
        ratio = uncompressed_mb / size_mb if size_mb > 0 else 0

        log.info(
            f"[H5Writer] Finalised: {self._h5_path}  "
            f"samples={self._written}  "
            f"disk={size_mb:.1f}MB  uncompressed={uncompressed_mb:.1f}MB  "
            f"ratio={ratio:.1f}x  status={status}"
        )

    @property
    def h5_path(self):
        return self._h5_path

    @property
    def samples_written(self):
        return self._written

    @property
    def seconds_available(self):
        return self._written / self._sr if self._sr > 0 else 0.0

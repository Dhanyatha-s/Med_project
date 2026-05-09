"""
edf_stream_parser.py  —  EDF parser using pyedflib backend
─────────────────────────────────────────────────────────────────────────────
Uses pyedflib to handle all EDF/EDF+ format variations correctly:
  - EDF+ Annotations pseudo-channels (variable SPR, not raw ECG)
  - Pyedflib-specific header quirks (blank SPR fields)
  - Variable record durations
  - All manufacturer naming conventions

For STREAMING (WiFi/USB) where the full file is not on disk yet:
  Data is buffered to a temp file as it arrives, then pyedflib reads it.
  The parser emits 5-second float32 chunks as soon as they are available.

For FILE-BASED sources (SD card, Bluetooth):
  File is already on disk — pyedflib reads it directly.

Public API (identical to the original streaming API):
  feed(raw_bytes)   → buffer bytes (streaming mode only)
  get_chunk()       → blocks until 5s float32 array ready, None when done
  header_ready      → threading.Event, set when header parsed
  header            → dict with n_leads, lead_names, sr, total_samples etc
  done              → bool
"""

import os, io, json, logging, threading, tempfile
import numpy as np

log = logging.getLogger(__name__)

_CHUNK_SEC   = 5      # seconds per output chunk
_LEAD_MAP = {
    "ECG1":"I", "ECG2":"II",  "ECG3":"III",
    "CH1":"I",  "CH2":"II",   "CH3":"III",
    "LEAD1":"I","LEAD2":"II", "LEAD3":"III",
    "C1":"I",   "C2":"II",    "C3":"III",
    "AVR":"aVR","AVL":"aVL",  "AVF":"aVF",
    "ECG I":"I","ECG II":"II","ECG III":"III",
}

def _normalise(names):
    out = []
    for n in names:
        upper = n.upper().replace(" ","")
        out.append(_LEAD_MAP.get(upper, n))
    return out


class EDFStreamParser:
    """
    Parses EDF files using pyedflib.
    Works in two modes:

    Mode A — file path given directly (SD card, Bluetooth, watcher):
        parse_file(path) reads the whole file at once using pyedflib.
        Emits 5-second chunks via get_chunk().

    Mode B — streaming bytes (WiFi, USB serial):
        feed(bytes) accumulates bytes into a temp file.
        When enough bytes arrive for the full file, calls parse_file().
        This is transparent to the caller.
    """

    def __init__(self):
        self.header_ready  = threading.Event()
        self._chunk_ready  = threading.Condition()
        self.header        = {}
        self.done          = False

        self._chunks       = []
        self._tmp_path     = None
        self._tmp_fh       = None
        self._bytes_written = 0
        self._bytes_total   = 0   # set by caller if known (Content-Length)
        self._parse_started = False
        self._lock          = threading.Lock()

    # ── Public: file-based (preferred) ───────────────────────────────────────

    def parse_file(self, edf_path: str) -> None:
        """
        Parse a complete EDF file from disk.
        Runs in the calling thread — call from a background thread.
        """
        log.info(f"[parser] Parsing: {edf_path}")
        self._do_parse(edf_path)

    # ── Public: streaming bytes ───────────────────────────────────────────────

    def set_total_bytes(self, n: int):
        """Call before feed() to enable auto-parse when all bytes received."""
        self._bytes_total = n

    def feed(self, raw_bytes: bytes) -> None:
        """Buffer incoming bytes. Auto-parses when complete file received."""
        if self._tmp_fh is None:
            fd, self._tmp_path = tempfile.mkstemp(suffix=".edf", prefix="holter_")
            self._tmp_fh = os.fdopen(fd, "wb")

        self._tmp_fh.write(raw_bytes)
        self._bytes_written += len(raw_bytes)

        # If we know total size and have received all bytes, parse now
        if (self._bytes_total > 0 and
                self._bytes_written >= self._bytes_total and
                not self._parse_started):
            self._tmp_fh.flush()
            self._parse_started = True
            t = threading.Thread(target=self._do_parse,
                                 args=(self._tmp_path,), daemon=True)
            t.start()

    def feed_complete(self) -> None:
        """
        Call this when the last byte has been fed (unknown total size case).
        Triggers parsing of whatever has been buffered.
        """
        if self._tmp_fh and not self._parse_started:
            self._tmp_fh.flush()
            self._parse_started = True
            t = threading.Thread(target=self._do_parse,
                                 args=(self._tmp_path,), daemon=True)
            t.start()

    # ── Public: chunk consumer ────────────────────────────────────────────────

    def get_chunk(self):
        """
        Block until a 5-second float32 chunk is available.
        Returns np.ndarray shape (sr*5, n_leads), or None when done.
        """
        with self._chunk_ready:
            while not self._chunks and not self.done:
                self._chunk_ready.wait(timeout=0.5)
            if self._chunks:
                return self._chunks.pop(0)
        return None

    # ── Internal ──────────────────────────────────────────────────────────────

    def _do_parse(self, edf_path: str) -> None:
        """
        Uses pyedflib to read EDF. Handles all format quirks automatically.
        Emits 5-second chunks as it reads.
        """
        try:
            import pyedflib
        except ImportError:
            log.error("[parser] pyedflib not installed: pip install pyedflib")
            self.done = True
            return

        try:
            f = pyedflib.EdfReader(edf_path)
        except Exception as e:
            log.error(f"[parser] Cannot open EDF: {e}")
            self.done = True
            with self._chunk_ready:
                self._chunk_ready.notify_all()
            return

        try:
            ns         = f.signals_in_file
            sr         = int(f.getSampleFrequency(0))
            n_records  = f.datarecords_in_file
            rec_dur    = f.datarecord_duration
            total_samp = int(f.getNSamples()[0])
            labels_raw = [f.getLabel(i).strip() for i in range(ns)]
            lead_names = _normalise(labels_raw)

            # Build header dict — identical structure to original parser
            self.header = {
                "n_leads":        ns,
                "lead_names":     lead_names,
                "sr":             sr,
                "spr":            int(sr * rec_dur),
                "total_samples":  total_samp,
                "duration_sec":   total_samp / sr if sr > 0 else 0,
                "n_records":      n_records,
                "record_dur_sec": rec_dur,
                "patient_name":   f.getPatientName().strip(),
                "patient_code":   f.getPatientCode().strip(),
                "start_date":     str(f.getStartdatetime().date()),
                "start_time":     str(f.getStartdatetime().time()),
                "prefilters":     [f.getPrefilter(i).strip() for i in range(ns)],
                "dimensions":     [f.getPhysicalDimension(i).strip() for i in range(ns)],
            }

            # Read patient diary annotations if present
            try:
                onsets, durs, labels = f.readAnnotations()
                self.header["annotations"] = [
                    {"onset_sec": float(o), "duration_sec": float(d or 0),
                     "label": str(l).strip()}
                    for o, d, l in zip(onsets, durs, labels)
                ] if len(onsets) > 0 else []
            except Exception:
                self.header["annotations"] = []

            log.info(
                f"[parser] Header: leads={lead_names}  sr={sr}Hz  "
                f"duration={total_samp/sr/3600:.2f}hr  records={n_records}"
            )
            self.header_ready.set()   # ← unblocks Thread 3 pre-allocation

            # Emit 5-second chunks by reading per-record with pyedflib
            chunk_sec    = _CHUNK_SEC
            records_per_chunk = max(1, int(chunk_sec / rec_dur))
            spr          = int(sr * rec_dur)          # samples per record

            record_buf   = []   # accumulate records until 5s worth
            records_done = 0

            while records_done < n_records:
                # Read next batch of records
                batch_end = min(records_done + records_per_chunk, n_records)
                start_samp = records_done * spr
                end_samp   = batch_end   * spr
                end_samp   = min(end_samp, total_samp)

                if start_samp >= total_samp:
                    break

                # Read all channels for this time slice
                cols = []
                for i in range(ns):
                    sig = f.readSignal(i,
                                       start=start_samp,
                                       n=end_samp - start_samp,
                                       digital=False)
                    cols.append(sig.astype(np.float32))

                chunk = np.column_stack(cols)   # shape (n_samp, n_leads)

                with self._chunk_ready:
                    self._chunks.append(chunk)
                    self._chunk_ready.notify_all()

                records_done = batch_end

        except Exception as e:
            log.error(f"[parser] Parse error: {e}")
            import traceback; traceback.print_exc()
        finally:
            try:
                f._close()
            except Exception:
                pass

        # Signal completion
        self.done = True
        with self._chunk_ready:
            self._chunk_ready.notify_all()

        log.info(f"[parser] Done — {self.header.get('duration_sec',0)/3600:.2f}hr parsed")

        # Clean up temp file if used
        if self._tmp_path and os.path.exists(self._tmp_path):
            try:
                os.unlink(self._tmp_path)
            except Exception:
                pass

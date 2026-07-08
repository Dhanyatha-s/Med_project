# """
# ingest_stream.py  —  Streaming ingest session controller
# ─────────────────────────────────────────────────────────────────────────────
# Orchestrates the 3-thread pipeline for any transfer method.

#                   ┌─────────────────────────────────┐
#   feed(bytes) ──► │ Thread 1: transport reader       │ ← file path source only
#                   │   reads 64KB chunks from file    │
#                   │   queue1.put(chunk)              │
#                   ├─────────────────────────────────┤
#                   │ Thread 2: parser worker          │
#                   │   EDFStreamParser.get_chunk()    │
#                   │   parser.header_ready → pre_alloc│
#                   │   queue2.put(samples)            │
#                   ├─────────────────────────────────┤
#                   │ Thread 3: writer worker          │
#                   │   H5StreamWriter.append_chunk()  │
#                   │   progress_store.update()        │
#                   └─────────────────────────────────┘

# For WiFi uploads: Thread 1 is NOT started. Flask endpoint calls feed() directly.
# For SD/USB/file:  Thread 1 is started. It reads the file and calls feed() in a loop.
# For Bluetooth:    File already written to disk by OS. Same as SD card path.
# """

# import os
# import queue
# import logging
# import threading
# import numpy as np

# from acquisition.progress_store    import create_session, update as store_update
# from acquisition.edf_stream_parser import EDFStreamParser
# from acquisition.h5_stream_writer  import H5StreamWriter

# log = logging.getLogger(__name__)

# _CHUNK_SIZE    = 65536  # 64 KB — transport read size
# _QUEUE_MAXSIZE = 8      # bound queue so slow writer back-pressures parser

# # Resolve the data dir relative to this file (acquisition/ → ../data)
# _DATA_DIR = os.path.normpath(
#     os.path.join(os.path.dirname(__file__), "..", "data")
# )


# class IngestSession:
#     """
#     One instance per file transfer.
#     Works identically for SD card, USB serial, WiFi, and Bluetooth.
#     """

#     def __init__(
#         self,
#         patient_id:    str,
#         source_path:   str = None,      # if given: Thread 1 reads this file
#         bytes_total:   int = 0,         # from Content-Length header (WiFi) or file size
#         source_method: str = "unknown", # "wifi" | "bt" | "usb" | "sd" | "unknown"
#     ):
#         self.patient_id     = patient_id
#         self._source_path   = source_path
#         self._source_method = source_method          # ← stored correctly in body
#         self._bytes_total   = bytes_total if bytes_total > 0 else (
#             os.path.getsize(source_path) if source_path else 0
#         )

#         # Create progress record
#         self.session_id = create_session(
#             patient_id    = patient_id,
#             bytes_total   = self._bytes_total,
#             source_method = source_method,
#         )

#         # Pipeline components
#         self._parser = EDFStreamParser()
#         self._writer = H5StreamWriter(patient_id, self.session_id)

#         # Thread communication
#         self._q2         = queue.Queue(maxsize=_QUEUE_MAXSIZE)
#         self._cancel     = threading.Event()
#         self._bytes_recv = 0
#         self._error      = None

#         # Start pipeline threads
#         self._t2 = threading.Thread(
#             target=self._parser_worker,
#             name=f"parser-{self.session_id[:6]}",
#             daemon=True,
#         )
#         self._t3 = threading.Thread(
#             target=self._writer_worker,
#             name=f"writer-{self.session_id[:6]}",
#             daemon=True,
#         )
#         self._t2.start()
#         self._t3.start()

#         # Thread 1 only for file-based sources
#         if source_path:
#             self._t1 = threading.Thread(
#                 target=self._file_reader,
#                 name=f"reader-{self.session_id[:6]}",
#                 daemon=True,
#             )
#             self._t1.start()
#         else:
#             self._t1 = None

#         log.info(
#             f"[IngestSession] {self.session_id[:8]}  patient={patient_id}"
#             f"  method={source_method}  size={self._bytes_total/1e6:.1f}MB"
#         )

#     # ── Public API ────────────────────────────────────────────────────────────

#     def feed(self, raw_bytes: bytes) -> None:
#         """
#         Accept raw bytes from any external source (Flask WiFi endpoint, etc).
#         Thread-safe. DO NOT call when source_path was given — Thread 1 handles it.
#         """
#         if self._cancel.is_set():
#             return
#         self._parser.feed(raw_bytes)
#         self._bytes_recv += len(raw_bytes)
#         store_update(self.session_id, bytes_received=self._bytes_recv)

#     def cancel(self) -> None:
#         """Abort the session cleanly. Threads exit on next iteration."""
#         self._cancel.set()
#         store_update(self.session_id, status="error", error_message="Cancelled by user")
#         log.info(f"[IngestSession] {self.session_id[:8]} cancelled")

#     @property
#     def h5_path(self):
#         return self._writer.h5_path

#     @property
#     def status(self):
#         from acquisition.progress_store import get
#         s = get(self.session_id)
#         return s["status"] if s else "unknown"

#     @property
#     def seconds_available(self):
#         return self._writer.seconds_available

#     # ── Thread 1: file reader (SD card / USB / Bluetooth) ────────────────────

#     def _file_reader(self):
#         """
#         For file-based sources, parse_file() is called directly in _parser_worker.
#         This thread just marks bytes_received from the file size so the progress
#         bar reaches 100 % immediately (the bottleneck is parsing/writing, not I/O).
#         """
#         try:
#             size = os.path.getsize(self._source_path)
#             store_update(
#                 self.session_id,
#                 status        = "receiving",
#                 bytes_total   = size,
#                 bytes_received= size,
#             )
#             self._bytes_recv = size
#             log.info(f"[T1-reader] File size: {size/1e6:.1f}MB — parse_file handles reading")
#         except Exception as e:
#             log.error(f"[T1-reader] Error: {e}")

#     # ── Thread 2: parser worker ───────────────────────────────────────────────

#     def _parser_worker(self):
#         """
#         For file-based sources: spawn parse_file() internally.
#         For WiFi/streaming:     header_ready fires once feed_complete() is called.
#         Forwards parsed 5-second chunks to Thread 3 via _q2.
#         """
#         log.info("[T2-parser] Started")

#         # For file-based sources kick off pyedflib parsing in a sub-thread
#         if self._source_path:
#             pt = threading.Thread(
#                 target=self._parser.parse_file,
#                 args=(self._source_path,),
#                 daemon=True,
#                 name=f"parse-file-{self.session_id[:6]}",
#             )
#             pt.start()

#         # Wait for EDF header (set by parse_file or feed_complete)
#         self._parser.header_ready.wait(timeout=60)
#         if not self._parser.header_ready.is_set():
#             msg = "EDF header not received within 60s"
#             log.error(f"[T2-parser] {msg}")
#             store_update(self.session_id, status="error", error_message=msg)
#             return

#         header = self._parser.header
#         log.info(
#             f"[T2-parser] Header parsed: leads={header['lead_names']}"
#             f"  sr={header['sr']}Hz  duration={header['duration_sec']/3600:.2f}hr"
#         )
#         store_update(
#             self.session_id,
#             status        = "writing",
#             lead_names    = header["lead_names"],
#             sampling_rate = header["sr"],
#             total_samples = header["total_samples"],
#         )

#         # Trigger H5 pre-allocation so Thread 3 can start receiving chunks
#         try:
#             h5_path = self._writer.pre_allocate(header)
#             store_update(self.session_id, h5_path=h5_path)
#             log.info(f"[T2-parser] H5 pre-allocated → {h5_path}")
#         except Exception as e:
#             log.error(f"[T2-parser] pre_allocate failed: {e}")
#             store_update(self.session_id, status="error", error_message=str(e))
#             return

#         # Forward parsed chunks to Thread 3
#         while not self._cancel.is_set():
#             chunk = self._parser.get_chunk()
#             if chunk is None:
#                 break   # parser signals done
#             try:
#                 self._q2.put(chunk, timeout=30)
#             except queue.Full:
#                 log.warning("[T2-parser] Writer queue full — back-pressure from disk")
#                 self._q2.put(chunk)   # block without timeout

#         # Send sentinel so Thread 3 exits cleanly
#         self._q2.put(None)
#         log.info("[T2-parser] Done.")

#     # ── Thread 3: writer worker ───────────────────────────────────────────────

#     def _writer_worker(self):
#         """Receive parsed chunks from _q2, append to H5, then register in DB."""
#         log.info("[T3-writer] Started, waiting for first chunk...")

#         while not self._cancel.is_set():
#             try:
#                 chunk = self._q2.get(timeout=1.0)
#             except queue.Empty:
#                 continue

#             if chunk is None:
#                 break   # sentinel from parser worker

#             try:
#                 written = self._writer.append_chunk(chunk)
#                 secs    = self._writer.seconds_available
#                 store_update(
#                     self.session_id,
#                     samples_written   = written,
#                     seconds_available = secs,
#                 )
#             except Exception as e:
#                 log.error(f"[T3-writer] append_chunk failed: {e}")
#                 store_update(self.session_id, status="error", error_message=str(e))
#                 return

#         # ── Finalise ──────────────────────────────────────────────────────────
#         if not self._cancel.is_set():
#             try:
#                 self._writer.finalise("complete")
#                 store_update(
#                     self.session_id,
#                     status            = "complete",
#                     samples_written   = self._writer.samples_written,
#                     seconds_available = self._writer.seconds_available,
#                 )
#                 log.info(
#                     f"[T3-writer] Complete."
#                     f" {self._writer.seconds_available/3600:.2f}hr written."
#                     f" Session: {self.session_id[:8]}"
#                 )

#                 # ── Register source in patients DB ────────────────────────────
#                 # This is the only place where source_method reaches the DB for
#                 # watcher (SD), USB, and BT paths.  The WiFi path also calls
#                 # auto_register_patient from api.py /api/import, but having it
#                 # here too is harmless and ensures nothing is missed.
#                 try:
#                     from database import auto_register_patient
#                     auto_register_patient(
#                         patient_id    = self.patient_id,
#                         name          = self.patient_id,
#                         h5_rel_path   = self._writer.h5_path,
#                         n_leads       = getattr(self._writer, "n_leads", 0),
#                         data_dir      = _DATA_DIR,
#                         source_method = self._source_method,
#                     )
#                     log.info(
#                         f"[T3-writer] DB updated:"
#                         f" patient={self.patient_id}"
#                         f" source={self._source_method}"
#                     )
#                 except Exception as db_err:
#                     log.warning(f"[T3-writer] DB source update failed: {db_err}")
#                 # ── End DB registration ───────────────────────────────────────

#             except Exception as e:
#                 log.error(f"[T3-writer] finalise failed: {e}")
#                 store_update(self.session_id, status="error", error_message=str(e))
#         else:
#             self._writer.finalise("error")
# =========================================================================================
# ==========================================================================================
# ====================================================================================
"""
ingest_stream.py  —  Streaming ingest session controller
─────────────────────────────────────────────────────────────────────────────
Orchestrates the 3-thread pipeline for any transfer method.

                  ┌─────────────────────────────────┐
  feed(bytes) ──► │ Thread 1: transport reader       │ ← file path source only
                  │   reads 64KB chunks from file    │
                  │   queue1.put(chunk)              │
                  ├─────────────────────────────────┤
                  │ Thread 2: parser worker          │
                  │   EDFStreamParser.get_chunk()    │
                  │   parser.header_ready → pre_alloc│
                  │   queue2.put(samples)            │
                  ├─────────────────────────────────┤
                  │ Thread 3: writer worker          │
                  │   H5StreamWriter.append_chunk()  │
                  │   progress_store.update()        │
                  └─────────────────────────────────┘

For WiFi uploads: Thread 1 is NOT started. Flask endpoint calls feed() directly.
For SD/USB/file:  Thread 1 is started. It reads the file and calls feed() in a loop.
For Bluetooth:    File already written to disk by OS. Same as SD card path.

v2 — On finalise, patient demographics (name/age/sex) are extracted via
acquisition.patient_meta.extract_patient_meta() (reads a .meta.json sidecar
written by the BT RFCOMM receiver, or falls back to parsing the EDF header
directly) and passed to auto_register_patient(). database.auto_register_patient
only writes age/sex/name if they are not already set, so manual edits are
never clobbered.
"""

import os
import queue
import logging
import threading
import numpy as np

from acquisition.progress_store    import create_session, update as store_update
from acquisition.edf_stream_parser import EDFStreamParser
from acquisition.h5_stream_writer  import H5StreamWriter

log = logging.getLogger(__name__)

_CHUNK_SIZE    = 65536  # 64 KB — transport read size
_QUEUE_MAXSIZE = 8      # bound queue so slow writer back-pressures parser

# Resolve the data dir relative to this file (acquisition/ → ../data)
_DATA_DIR = os.path.normpath(
    os.path.join(os.path.dirname(__file__), "..", "data")
)


class IngestSession:
    """
    One instance per file transfer.
    Works identically for SD card, USB serial, WiFi, and Bluetooth.
    """

    def __init__(
        self,
        patient_id:    str,
        source_path:   str = None,      # if given: Thread 1 reads this file
        bytes_total:   int = 0,         # from Content-Length header (WiFi) or file size
        source_method: str = "unknown", # "wifi" | "bt" | "usb" | "sd" | "unknown"
    ):
        self.patient_id     = patient_id
        self._source_path   = source_path
        self._source_method = source_method          # ← stored correctly in body
        self._bytes_total   = bytes_total if bytes_total > 0 else (
            os.path.getsize(source_path) if source_path else 0
        )

        # Create progress record
        self.session_id = create_session(
            patient_id    = patient_id,
            bytes_total   = self._bytes_total,
            source_method = source_method,
        )

        # Pipeline components
        self._parser = EDFStreamParser()
        self._writer = H5StreamWriter(patient_id, self.session_id)

        # Thread communication
        self._q2         = queue.Queue(maxsize=_QUEUE_MAXSIZE)
        self._cancel     = threading.Event()
        self._bytes_recv = 0
        self._error      = None

        # Start pipeline threads
        self._t2 = threading.Thread(
            target=self._parser_worker,
            name=f"parser-{self.session_id[:6]}",
            daemon=True,
        )
        self._t3 = threading.Thread(
            target=self._writer_worker,
            name=f"writer-{self.session_id[:6]}",
            daemon=True,
        )
        self._t2.start()
        self._t3.start()

        # Thread 1 only for file-based sources
        if source_path:
            self._t1 = threading.Thread(
                target=self._file_reader,
                name=f"reader-{self.session_id[:6]}",
                daemon=True,
            )
            self._t1.start()
        else:
            self._t1 = None

        log.info(
            f"[IngestSession] {self.session_id[:8]}  patient={patient_id}"
            f"  method={source_method}  size={self._bytes_total/1e6:.1f}MB"
        )

    # ── Public API ────────────────────────────────────────────────────────────

    def feed(self, raw_bytes: bytes) -> None:
        """
        Accept raw bytes from any external source (Flask WiFi endpoint, etc).
        Thread-safe. DO NOT call when source_path was given — Thread 1 handles it.
        """
        if self._cancel.is_set():
            return
        self._parser.feed(raw_bytes)
        self._bytes_recv += len(raw_bytes)
        store_update(self.session_id, bytes_received=self._bytes_recv)

    def cancel(self) -> None:
        """Abort the session cleanly. Threads exit on next iteration."""
        self._cancel.set()
        store_update(self.session_id, status="error", error_message="Cancelled by user")
        log.info(f"[IngestSession] {self.session_id[:8]} cancelled")

    @property
    def h5_path(self):
        return self._writer.h5_path

    @property
    def status(self):
        from acquisition.progress_store import get
        s = get(self.session_id)
        return s["status"] if s else "unknown"

    @property
    def seconds_available(self):
        return self._writer.seconds_available

    # ── Thread 1: file reader (SD card / USB / Bluetooth) ────────────────────

    def _file_reader(self):
        """
        For file-based sources, parse_file() is called directly in _parser_worker.
        This thread just marks bytes_received from the file size so the progress
        bar reaches 100 % immediately (the bottleneck is parsing/writing, not I/O).
        """
        try:
            size = os.path.getsize(self._source_path)
            store_update(
                self.session_id,
                status        = "receiving",
                bytes_total   = size,
                bytes_received= size,
            )
            self._bytes_recv = size
            log.info(f"[T1-reader] File size: {size/1e6:.1f}MB — parse_file handles reading")
        except Exception as e:
            log.error(f"[T1-reader] Error: {e}")

    # ── Thread 2: parser worker ───────────────────────────────────────────────

    def _parser_worker(self):
        """
        For file-based sources: spawn parse_file() internally.
        For WiFi/streaming:     header_ready fires once feed_complete() is called.
        Forwards parsed 5-second chunks to Thread 3 via _q2.
        """
        log.info("[T2-parser] Started")

        # For file-based sources kick off pyedflib parsing in a sub-thread
        if self._source_path:
            pt = threading.Thread(
                target=self._parser.parse_file,
                args=(self._source_path,),
                daemon=True,
                name=f"parse-file-{self.session_id[:6]}",
            )
            pt.start()

        # Wait for EDF header (set by parse_file or feed_complete)
        self._parser.header_ready.wait(timeout=60)
        if not self._parser.header_ready.is_set():
            msg = "EDF header not received within 60s"
            log.error(f"[T2-parser] {msg}")
            store_update(self.session_id, status="error", error_message=msg)
            return

        header = self._parser.header
        log.info(
            f"[T2-parser] Header parsed: leads={header['lead_names']}"
            f"  sr={header['sr']}Hz  duration={header['duration_sec']/3600:.2f}hr"
        )
        store_update(
            self.session_id,
            status        = "writing",
            lead_names    = header["lead_names"],
            sampling_rate = header["sr"],
            total_samples = header["total_samples"],
        )

        # Trigger H5 pre-allocation so Thread 3 can start receiving chunks
        try:
            h5_path = self._writer.pre_allocate(header)
            store_update(self.session_id, h5_path=h5_path)
            log.info(f"[T2-parser] H5 pre-allocated → {h5_path}")
        except Exception as e:
            log.error(f"[T2-parser] pre_allocate failed: {e}")
            store_update(self.session_id, status="error", error_message=str(e))
            return

        # Forward parsed chunks to Thread 3
        while not self._cancel.is_set():
            chunk = self._parser.get_chunk()
            if chunk is None:
                break   # parser signals done
            try:
                self._q2.put(chunk, timeout=30)
            except queue.Full:
                log.warning("[T2-parser] Writer queue full — back-pressure from disk")
                self._q2.put(chunk)   # block without timeout

        # Send sentinel so Thread 3 exits cleanly
        self._q2.put(None)
        log.info("[T2-parser] Done.")

    # ── Thread 3: writer worker ───────────────────────────────────────────────

    def _writer_worker(self):
        """Receive parsed chunks from _q2, append to H5, then register in DB."""
        log.info("[T3-writer] Started, waiting for first chunk...")

        while not self._cancel.is_set():
            try:
                chunk = self._q2.get(timeout=1.0)
            except queue.Empty:
                continue

            if chunk is None:
                break   # sentinel from parser worker

            try:
                written = self._writer.append_chunk(chunk)
                secs    = self._writer.seconds_available
                store_update(
                    self.session_id,
                    samples_written   = written,
                    seconds_available = secs,
                )
            except Exception as e:
                log.error(f"[T3-writer] append_chunk failed: {e}")
                store_update(self.session_id, status="error", error_message=str(e))
                return

        # ── Finalise ──────────────────────────────────────────────────────────
        if not self._cancel.is_set():
            try:
                self._writer.finalise("complete")
                store_update(
                    self.session_id,
                    status            = "complete",
                    samples_written   = self._writer.samples_written,
                    seconds_available = self._writer.seconds_available,
                )
                log.info(
                    f"[T3-writer] Complete."
                    f" {self._writer.seconds_available/3600:.2f}hr written."
                    f" Session: {self.session_id[:8]}"
                )

                # ── Register source + demographics in patients DB ─────────────
                # This is the only place where source_method (and, when
                # available, age/sex/name) reaches the DB for watcher (SD),
                # USB, and BT paths. The WiFi path also calls
                # auto_register_patient from api.py /api/import, but having
                # it here too is harmless and ensures nothing is missed.
                try:
                    from database import auto_register_patient
                    from acquisition.patient_meta import extract_patient_meta

                    meta = {}
                    if self._source_path:
                        try:
                            meta = extract_patient_meta(self._source_path)
                        except Exception as meta_err:
                            log.warning(
                                f"[T3-writer] patient_meta extraction failed: "
                                f"{meta_err}"
                            )

                    resolved_name = meta.get("name") or self.patient_id

                    auto_register_patient(
                        patient_id    = self.patient_id,
                        name          = resolved_name,
                        h5_rel_path   = self._writer.h5_path,
                        n_leads       = getattr(self._writer, "n_leads", 0),
                        data_dir      = _DATA_DIR,
                        source_method = self._source_method,
                        age           = meta.get("age"),
                        sex           = meta.get("sex"),
                    )
                    log.info(
                        f"[T3-writer] DB updated:"
                        f" patient={self.patient_id}"
                        f" source={self._source_method}"
                        f" age={meta.get('age')}"
                        f" sex={meta.get('sex')}"
                        f" name={resolved_name}"
                    )
                except Exception as db_err:
                    log.warning(f"[T3-writer] DB source update failed: {db_err}")
                # ── End DB registration ───────────────────────────────────────

            except Exception as e:
                log.error(f"[T3-writer] finalise failed: {e}")
                store_update(self.session_id, status="error", error_message=str(e))
        else:
            self._writer.finalise("error")
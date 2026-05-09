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

_CHUNK_SIZE   = 65536   # 64 KB — transport read size
_QUEUE_MAXSIZE = 8      # bound queue so slow writer back-pressures parser


class IngestSession:
    """
    One instance per file transfer.
    Works identically for SD card, USB serial, WiFi, and Bluetooth.
    """

    def __init__(
        self,
        patient_id:    str,
        source_path:   str  = None,   # if given: Thread 1 reads this file
        bytes_total:   int  = 0,      # from Content-Length header (WiFi) or file size (file)
        source_method: str  = "unknown",
    ):
        self.patient_id    = patient_id
        self._source_path  = source_path
        self._bytes_total  = bytes_total if bytes_total > 0 else (
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
        self._q2         = queue.Queue(maxsize=_QUEUE_MAXSIZE)  # parsed chunks → writer
        self._cancel     = threading.Event()
        self._bytes_recv = 0
        self._error      = None

        # Start pipeline threads
        self._t2 = threading.Thread(target=self._parser_worker, name=f"parser-{self.session_id[:6]}", daemon=True)
        self._t3 = threading.Thread(target=self._writer_worker, name=f"writer-{self.session_id[:6]}", daemon=True)
        self._t2.start()
        self._t3.start()

        # Thread 1 only for file-based sources
        if source_path:
            self._t1 = threading.Thread(target=self._file_reader, name=f"reader-{self.session_id[:6]}", daemon=True)
            self._t1.start()
        else:
            self._t1 = None

        log.info(f"[IngestSession] {self.session_id[:8]}  patient={patient_id}  method={source_method}  size={self._bytes_total/1e6:.1f}MB")

    # ── Public API ────────────────────────────────────────────────────────────

    def feed(self, raw_bytes: bytes) -> None:
        """
        Accept raw bytes from any external source (Flask WiFi endpoint, etc).
        Thread-safe. DO NOT call this when source_path was given — Thread 1 handles it.
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
        """For file-based sources, parse_file() is called directly in parser_worker.
        This thread just marks bytes_received from the file size."""
        try:
            size = os.path.getsize(self._source_path)
            store_update(self.session_id, status="receiving",
                         bytes_total=size, bytes_received=size)
            self._bytes_recv = size
            log.info(f"[T1-reader] File size: {size/1e6:.1f}MB — parse_file handles reading")
        except Exception as e:
            log.error(f"[T1-reader] Error: {e}")

    # ── Thread 2: parser worker ───────────────────────────────────────────────

    def _parser_worker(self):
        """
        For file-based sources: call parse_file() which runs pyedflib internally.
        For WiFi/streaming: header_ready fires once feed_complete() is called.
        Forwards parsed 5-second chunks to Thread 3 via queue2.
        """
        log.info(f"[T2-parser] Started")

        # For file-based sources: kick off parsing now
        if self._source_path:
            import threading
            pt = threading.Thread(
                target=self._parser.parse_file,
                args=(self._source_path,),
                daemon=True,
                name=f"parse-file-{self.session_id[:6]}"
            )
            pt.start()

        # Wait for header — set by parse_file() or feed_complete()
        self._parser.header_ready.wait(timeout=60)
        if not self._parser.header_ready.is_set():
            msg = "EDF header not received within 60s"
            log.error(f"[T2-parser] {msg}")
            store_update(self.session_id, status="error", error_message=msg)
            return

        header = self._parser.header
        log.info(
            f"[T2-parser] Header parsed: leads={header['lead_names']}  "
            f"sr={header['sr']}Hz  duration={header['duration_sec']/3600:.2f}hr"
        )
        store_update(
            self.session_id,
            status        = "writing",
            lead_names    = header["lead_names"],
            sampling_rate = header["sr"],
            total_samples = header["total_samples"],
        )

        # Trigger H5 pre-allocation (Thread 3 can now start receiving chunks)
        try:
            h5_path = self._writer.pre_allocate(header)
            store_update(self.session_id, h5_path=h5_path)
            log.info(f"[T2-parser] H5 pre-allocated → {h5_path}")
        except Exception as e:
            log.error(f"[T2-parser] pre_allocate failed: {e}")
            store_update(self.session_id, status="error", error_message=str(e))
            return

        # Forward chunks to Thread 3
        while not self._cancel.is_set():
            chunk = self._parser.get_chunk()
            if chunk is None:
                break   # parser.done = True
            try:
                self._q2.put(chunk, timeout=30)
            except queue.Full:
                log.warning("[T2-parser] Writer queue full — back-pressure from disk")
                self._q2.put(chunk)   # block without timeout

        # Flush sentinel
        self._q2.put(None)
        log.info(f"[T2-parser] Done.")

    # ── Thread 3: writer worker ───────────────────────────────────────────────

    def _writer_worker(self):
        """Receive parsed chunks from queue2 and append to H5."""
        log.info(f"[T3-writer] Started, waiting for first chunk...")

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

        # Finalise
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
                    f"[T3-writer] Complete. {self._writer.seconds_available/3600:.2f}hr written. "
                    f"Session: {self.session_id[:8]}"
                )
            except Exception as e:
                log.error(f"[T3-writer] finalise failed: {e}")
                store_update(self.session_id, status="error", error_message=str(e))
        else:
            self._writer.finalise("error")

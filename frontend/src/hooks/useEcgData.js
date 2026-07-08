/**
 * useEcgData.js  —  Smooth sliding-window ECG data hook
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT CAUSE of the 30s chunk stutter (fixed here):
 *
 *   Old code quantised timeOffset to hard window boundaries:
 *     windowStart = Math.floor(timeOff / winSec) * winSec
 *   So every time the playhead crossed a 30s (or winSec) boundary, the entire
 *   leadsMap was thrown away and a fresh fetch fired — causing the blank flash.
 *
 * THIS VERSION uses a sliding chunk buffer instead:
 *
 *   1. Data is always fetched in CHUNK_SEC (30s) blocks — the API hard limit.
 *   2. A Map<chunkIndex → Map<leadName, Float32Array>> buffer is kept in memory.
 *   3. The canvas receives a SLICE of the buffer from timeOffset to
 *      timeOffset + windowSec — recomputed every tick, pure memory math.
 *   4. Background prefetch keeps LOOKAHEAD_CHUNKS ahead loaded at all times.
 *   5. Old chunks beyond BUFFER_BEHIND behind the playhead are evicted.
 *
 * Fixes applied vs previous version:
 *   [1] sr promoted to state (not just a ref) so ECGCanvas timing calculations
 *       (px/sec, PR/RR intervals) are correct from first render with real SR.
 *       srRef kept alongside for synchronous use inside callbacks.
 *   [2] Effect dependency uses Math.floor(timeOffset) — prevents 60fps RAF
 *       ticks from spamming the effect during playback. The deliverSlice call
 *       inside ECGViewer's canvas re-render handles sub-second visual updates
 *       from already-buffered data without re-running the effect.
 *   [3] totalSec default 172800 (48hr) — correct for Holter recordings.
 *       Updated to actual value on first fetch response.
 *   [4] sr state reset to SR_DEFAULT on patient change (was only resetting ref).
 */

/**
 * useEcgData.js  —  Smooth sliding-window ECG data hook
 * ─────────────────────────────────────────────────────────────────────────────
 * ROOT CAUSE of the 30s chunk stutter (fixed previously):
 *
 *   Old code quantised timeOffset to hard window boundaries:
 *     windowStart = Math.floor(timeOff / winSec) * winSec
 *   So every time the playhead crossed a 30s (or winSec) boundary, the entire
 *   leadsMap was thrown away and a fresh fetch fired — causing the blank flash.
 *
 * THIS VERSION uses a sliding chunk buffer instead:
 *
 *   1. Data is always fetched in CHUNK_SEC (30s) blocks — the API hard limit.
 *   2. A Map<chunkIndex → Map<leadName, Float32Array>> buffer is kept in memory.
 *   3. The canvas receives a SLICE of the buffer from timeOffset to
 *      timeOffset + windowSec — recomputed every tick, pure memory math.
 *   4. Background prefetch keeps LOOKAHEAD_CHUNKS ahead loaded at all times.
 *   5. Old chunks beyond BUFFER_BEHIND behind the playhead are evicted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX [5] — REMOVED the post-slice downsample() call that was breaking time
 * alignment at wide windows (5min/10min/20min) and producing solid black
 * "smudge" blocks with duplicate PQRST markers.
 *
 *   Root cause: downsample(slice, MAX_CANVAS_SAMPLES) shrank a lead's buffer
 *   to <=6000 points using min/max bucketing, but never adjusted `sr` to
 *   match. ECGCanvas always computes x-position as `index / sr`, so it had
 *   no way to know the buffer no longer represented real-time samples at
 *   that rate — it rendered all 6000 decimated points as if they spanned
 *   only `6000 / sr` seconds instead of the real window length, cramming a
 *   5-minute strip into ~24 seconds of screen space and producing the
 *   black-block artifact.
 *
 *   ECGCanvas already implements a correct, sr-aware, per-pixel min/max
 *   envelope renderer for wide windows (see its drawTrace "WIDE ZOOM"
 *   branch) — decimation belongs there, where real screen width, zoom and
 *   sr are all known, not here. This hook now hands over the real,
 *   correctly-timed slice and lets the canvas do all decimation.
 *
 * Fixes applied vs previous versions:
 *   [1] sr promoted to state (not just a ref) so ECGCanvas timing calculations
 *       (px/sec, PR/RR intervals) are correct from first render with real SR.
 *       srRef kept alongside for synchronous use inside callbacks.
 *   [2] Effect dependency uses Math.floor(timeOffset) — prevents 60fps RAF
 *       ticks from spamming the effect during playback. The deliverSlice call
 *       inside ECGViewer's canvas re-render handles sub-second visual updates
 *       from already-buffered data without re-running the effect.
 *   [3] totalSec default 172800 (48hr) — correct for Holter recordings.
 *       Updated to actual value on first fetch response.
 *   [4] sr state reset to SR_DEFAULT on patient change (was only resetting ref).
 *   [5] Removed the rate-breaking pre-downsample (see above) — ECGCanvas is
 *       now the single source of truth for decimation at every zoom level.
 */

import { useState, useEffect, useRef, useCallback } from "react";

// ── Constants ────────────────────────────────────────────────────────────────

const CHUNK_SEC          = 30;    // API hard max per request — do not raise
const SR_DEFAULT         = 250;
const LOOKAHEAD_CHUNKS   = 2;     // Chunks ahead to prefetch
const BUFFER_BEHIND      = 1;     // Chunks behind current to keep in memory
const BASE_WINDOW_SEC    = 10;    // Matches ECGViewer zoom baseline

// ── Pure helpers (no hooks) ──────────────────────────────────────────────────

/** Fetch one 30s chunk from the API */
async function fetchChunk(patientId, startSec, signal) {
  const url = `/api/ecg/${patientId}?start=${startSec.toFixed(2)}&duration=${CHUNK_SEC}`;
  const res = await fetch(url, signal ? { signal } : {});
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      `${res.status} — ${body.error || res.statusText}` +
      (body.data_dir  ? `\ndata_dir: ${body.data_dir}`             : "") +
      (body.available ? `\navailable: ${body.available.join(", ")}` : "")
    );
  }
  return res.json();
}

/** API response leads object → Map<leadName, Float32Array> */
function buildLeadMap(data) {
  const map = new Map();
  for (const [name, raw] of Object.entries(data.leads ?? {})) {
    if (raw?.length > 0) map.set(name, new Float32Array(raw));
  }
  return map;
}

/**
 * Slice [startSec, startSec + windowSec] from the chunk buffer.
 * Buffer is Map<chunkIndex, Map<leadName, Float32Array>>.
 * Returns null if any required chunk is missing.
 *
 * Returns RAW, full-resolution samples at the real sample rate — every
 * index i still means "the sample at time startSec + i/sr". Nothing in
 * this hook is allowed to break that invariant; ECGCanvas depends on it
 * for every x-position it draws.
 */
function sliceFromBuffer(buffer, leadNames, startSec, windowSec, sr) {
  const endSec     = startSec + windowSec;
  const firstChunk = Math.floor(startSec / CHUNK_SEC);
  const lastChunk  = Math.ceil(endSec    / CHUNK_SEC) - 1;

  for (let ci = firstChunk; ci <= lastChunk; ci++) {
    if (!buffer.has(ci)) return null;
  }

  const totalSamples = Math.ceil(windowSec * sr);
  const result       = new Map();

  for (const name of leadNames) {
    const out   = new Float32Array(totalSamples);
    let written = 0;

    for (let ci = firstChunk; ci <= lastChunk; ci++) {
      const chunkMap  = buffer.get(ci);
      const buf       = chunkMap?.get(name);
      if (!buf) continue;

      const chunkStart = ci * CHUNK_SEC;
      const sampleOff  = Math.max(0, Math.round((startSec - chunkStart) * sr));
      const sampleEnd  = Math.min(buf.length, Math.round((endSec - chunkStart) * sr));
      const segment    = buf.subarray(sampleOff, sampleEnd);
      const copyLen    = Math.min(segment.length, totalSamples - written);
      out.set(segment.subarray(0, copyLen), written);
      written += copyLen;
    }

    result.set(name, written < totalSamples ? out.subarray(0, written) : out);
  }

  return result;
}

// ── Main hook ─────────────────────────────────────────────────────────────────

export default function useEcgData(patientId, timeOffset, zoom = 1) {
  const [leadsMap,  setLeadsMap]  = useState(null);
  const [leadNames, setLeadNames] = useState([]);
  const [sr,        setSr]        = useState(SR_DEFAULT);   // FIX [1]: state not just ref
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [totalSec,  setTotalSec]  = useState(172800);       // FIX [3]: 48hr default

  // Ref mirrors sr state for synchronous use inside callbacks
  // (state setters are async; callbacks need the value immediately)
  const srRef        = useRef(SR_DEFAULT);

  // Chunk buffer: Map<chunkIndex, Map<leadName, Float32Array>>
  const bufferRef    = useRef(new Map());

  // In-flight fetch indices — prevents duplicate parallel requests
  const fetchingRef  = useRef(new Set());

  // AbortController for the current blocking fetch group
  const abortRef     = useRef(null);

  // Stable lead names ref — avoids stale closures in async callbacks
  const leadNamesRef = useRef([]);

  const windowSec = BASE_WINDOW_SEC / zoom;

  // ── Evict chunks that have scrolled far behind the playhead ─────────────
  const evictOldChunks = useCallback((currentChunkIdx) => {
    const minKeep = currentChunkIdx - BUFFER_BEHIND;
    for (const ci of bufferRef.current.keys()) {
      if (ci < minKeep) bufferRef.current.delete(ci);
    }
  }, []);

  // ── Load one chunk into the buffer ──────────────────────────────────────
  const loadChunk = useCallback(async (pid, chunkIdx, signal) => {
    if (fetchingRef.current.has(chunkIdx)) return;
    if (bufferRef.current.has(chunkIdx))   return;

    fetchingRef.current.add(chunkIdx);

    try {
      const data  = await fetchChunk(pid, chunkIdx * CHUNK_SEC, signal);
      if (signal?.aborted) return;

      const apiSr    = data.sr ?? SR_DEFAULT;
      const apiNames = data.lead_names ?? [];
      const map      = buildLeadMap(data);
      if (map.size === 0) return;

      // FIX [1]: update both ref (sync) and state (triggers re-render with correct sr)
      if (apiSr !== srRef.current) {
        srRef.current = apiSr;
        setSr(apiSr);
      }

      // Only widen lead names — never narrow (guard against partial chunks)
      if (apiNames.length > leadNamesRef.current.length) {
        leadNamesRef.current = apiNames;
        setLeadNames(apiNames);
      }

      if (data.total_sec) setTotalSec(Math.floor(data.total_sec));

      bufferRef.current.set(chunkIdx, map);
    } catch (err) {
      if (err.name === "AbortError") return;
      throw err;
    } finally {
      fetchingRef.current.delete(chunkIdx);
    }
  }, []);

  // ── Deliver a slice from buffer to canvas (pure memory, no fetch) ────────
  // FIX [5]: hands over the RAW slice — no downsampling here. ECGCanvas's
  // own per-pixel min/max envelope renderer (sr- and zoom-aware) is the only
  // place decimation should happen, so PQRST shape survives at every speed
  // and every window size instead of degrading into a black block.
  const deliverSlice = useCallback((timeOff, winSec) => {
    const names = leadNamesRef.current;
    if (names.length === 0) return false;

    const slice = sliceFromBuffer(
      bufferRef.current, names, timeOff, winSec, srRef.current
    );
    if (!slice) return false;

    setLeadsMap(slice);
    setError(null);
    return true;
  }, []);

  // ── Main effect ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!patientId) return;

    const currentChunk = Math.floor(timeOffset / CHUNK_SEC);
    const chunksNeeded = Math.ceil(windowSec   / CHUNK_SEC);
    const lastRequired = currentChunk + chunksNeeded - 1;

    // Which required chunks are not yet in the buffer?
    const missing = [];
    for (let ci = currentChunk; ci <= lastRequired; ci++) {
      if (!bufferRef.current.has(ci) && !fetchingRef.current.has(ci)) {
        missing.push(ci);
      }
    }

    // ── All required chunks buffered — reslice and prefetch ahead ────────
    if (missing.length === 0) {
      deliverSlice(timeOffset, windowSec);
      evictOldChunks(currentChunk);

      for (let i = 1; i <= LOOKAHEAD_CHUNKS; i++) {
        const ci = lastRequired + i;
        if (!bufferRef.current.has(ci) && !fetchingRef.current.has(ci)) {
          loadChunk(patientId, ci, null).catch(() => {});
        }
      }
      return;
    }

    // ── Missing chunks — fetch (parallel), then reslice ──────────────────
    if (abortRef.current) abortRef.current.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // If we can partially serve from buffer, do so — avoids blank flash
    const hasPartial = deliverSlice(timeOffset, windowSec);
    if (!hasPartial) setLoading(true);
    setError(null);

    Promise.all(missing.map(ci => loadChunk(patientId, ci, ctrl.signal)))
      .then(() => {
        if (ctrl.signal.aborted) return;
        const ok = deliverSlice(timeOffset, windowSec);
        setLoading(false);
        if (!ok) setError("Incomplete data for this time range");
        else {
          evictOldChunks(currentChunk);
          for (let i = 1; i <= LOOKAHEAD_CHUNKS; i++) {
            const ci = lastRequired + i;
            if (!bufferRef.current.has(ci) && !fetchingRef.current.has(ci)) {
              loadChunk(patientId, ci, null).catch(() => {});
            }
          }
        }
      })
      .catch((err) => {
        if (err.name === "AbortError" || ctrl.signal.aborted) return;
        console.error("[useEcgData]", err.message);
        setError(err.message);
        setLoading(false);
      });

    return () => ctrl.abort();

  // FIX [2]: Math.floor prevents 60fps RAF ticks re-running this effect.
  // Sub-second canvas updates come from ECGCanvas re-rendering with the
  // same leadsMap — no new data needed between integer-second boundaries.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, Math.floor(timeOffset), zoom]);

  // ── Reset on patient change ──────────────────────────────────────────────
  useEffect(() => {
    if (abortRef.current) abortRef.current.abort();
    bufferRef.current    = new Map();
    fetchingRef.current  = new Set();
    leadNamesRef.current = [];
    srRef.current        = SR_DEFAULT;
    setSr(SR_DEFAULT);          // FIX [4]: reset state not just ref
    setLeadsMap(null);
    setLeadNames([]);
    setLoading(false);
    setError(null);
  }, [patientId]);

  return {
    leadsMap,
    leadNames,
    loading,
    error,
    totalSec,
    windowSec,
    sr,                         // FIX [1]: real state value, not ref snapshot
  };
}
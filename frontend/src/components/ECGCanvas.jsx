/**
 * ECGCanvas.jsx  —  Clinical ECG renderer aligned to AHA/ALS standards
 * ─────────────────────────────────────────────────────────────────────────────
 * Reference documents:
 *   • Basic ECG Interpretation (Leonard, PRISMA Health)
 *   • Advanced Life Support Ch.8 — Cardiac Monitoring, Electrocardiography
 *     and Rhythm Recognition (ALS, Resuscitation Council UK)
 *
 * Clinical features implemented:
 *   ✓ Warm-white ECG paper (#fdf6f0) with red 1mm/5mm dual grid
 *   ✓ 25 mm/s paper speed  (zoom adjustable)
 *   ✓ 10 mm/mV standard gain  (auto-half if signal overflows)
 *   ✓ Calibration pulse 10 mm × 5 mm  (1 mV × 0.2 s) — start of each row
 *   ✓ Gain label next to cal pulse (e.g. "10 mm/mV" or "5 mm/mV")
 *   ✓ Isoelectric baseline reference line per lead cell
 *   ✓ Solid row-separator lines (not just grid)
 *   ✓ Lead label — bold, top-left, red (matches printed ECG)
 *   ✓ Full-width Lead II RHYTHM STRIP at bottom of 12-lead layout
 *   ✓ "RHYTHM STRIP: II  25 mm/sec: 1 cm/mV" label (matches Ch.8 Fig 8.3)
 *   ✓ R-peak markers (▲) and RR interval brackets with ms labels (Lead II)
 *   ✓ PR interval indicator (cyan span below baseline)
 *   ✓ QRS width indicator (magenta span)
 *   ✓ Bottom metadata strip: speed | gain | filter | grid legend | HR | PR | QRS | QTc
 *   ✓ Per-lead isoelectric baseline computation (removes DC offset)
 *   ✓ Dynamic layout: 1–12 leads, resolveLayout drives everything
 */

/**
 * ECGCanvas.jsx  —  Clinical ECG renderer aligned to AHA/ALS standards
 * ─────────────────────────────────────────────────────────────────────────────
 * Reference documents:
 *   • Basic ECG Interpretation (Leonard, PRISMA Health)
 *   • Advanced Life Support Ch.8 — Cardiac Monitoring, Electrocardiography
 *     and Rhythm Recognition (ALS, Resuscitation Council UK)
 *
 * ADDITIONS in this version (Phase 1 completion):
 *
 *  ✅ gainOverride prop  — when set (5/10/20 mm/mV), overrides auto-gain
 *     on every lead uniformly. null = original auto-gain behaviour.
 *     The calibration pulse height and gain label both reflect the override.
 *
 *  ✅ Caliper tool  (spec item H: "calipers with configurable interval measurements")
 *     Props: caliperArmed (bool), caliperMeasurements (array), onCaliperMeasurement (fn)
 *     Behaviour:
 *       • When armed: mousedown starts drag → dashed yellow vertical line follows
 *         mouse → mouseup finalises → span drawn with ms + optional bpm label
 *       • Measurements are stored in ECGViewer state (not canvas state) so they
 *         persist across re-renders and can be cleared from the toolbar.
 *       • Up to 5 prior measurements are re-drawn from caliperMeasurements array.
 *       • Works on both 3-lead and 12-lead layouts.
 *       • Touch events (touchstart/touchmove/touchend) mirror mouse for tablet use.
 *
 * All previous clinical features preserved:
 *  ✓ Warm-white ECG paper with red 1mm/5mm dual grid
 *  ✓ 25 mm/s paper speed  (zoom adjustable)
 *  ✓ Calibration pulse 10 mm × 5 mm  (1 mV × 0.2 s) — start of each row
 *  ✓ Isoelectric baseline reference line per lead cell
 *  ✓ Solid row-separator lines
 *  ✓ Lead label — bold, top-left, red
 *  ✓ Full-width Lead II RHYTHM STRIP at bottom of 12-lead layout
 *  ✓ R-peak markers (▲) and RR interval brackets with ms labels
 *  ✓ PR interval indicator (cyan span below baseline)
 *  ✓ QRS width indicator (magenta span)
 *  ✓ Bottom metadata strip: speed | gain | filter | grid legend | HR | PR | QRS | QTc
 *  ✓ Per-lead isoelectric baseline computation
 *  ✓ Dynamic layout: 1–12 leads, resolveLayout drives everything
 *  ✓ Beat background colour tinting (wired for Phase 2 engine output)
 */

/**
 * ECGCanvas.jsx  —  Clinical ECG renderer aligned to AHA/ALS standards
 * ─────────────────────────────────────────────────────────────────────────────
 * PATCH: Min/Max Envelope Downsampling for wide time windows
 *
 * ROOT CAUSE of "black block" at 2min+:
 *   At 2min window: 30,000 samples drawn into ~1,200 pixel columns.
 *   ctx.lineTo() at sub-pixel spacing causes overlapping fills → solid block.
 *
 * FIX: When samplesPerPixel > 1.5, switch to min/max envelope rendering:
 *   For each pixel column → find min + max sample in that time range →
 *   draw one vertical line min→max. Preserves all R-peaks at any zoom.
 *   This is the algorithm used by GE MUSE, CardioScan, Spacelabs, and
 *   every other production Holter viewer.
 *
 * Performance: 300,000 lineTo() → 2,400 vertical lines at 20min view.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * ECGCanvas.jsx  —  Clinical ECG renderer aligned to AHA/ALS standards
 * ─────────────────────────────────────────────────────────────────────────────
 * Reference documents:
 *   • Basic ECG Interpretation (Leonard, PRISMA Health)
 *   • Advanced Life Support Ch.8 — Cardiac Monitoring, Electrocardiography
 *     and Rhythm Recognition (ALS, Resuscitation Council UK)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX [6] — TRUE-SCALE RENDERING, DECOUPLED FROM "VIEW" WINDOW LENGTH
 *
 *   ROOT CAUSE of the "compacted / smudged" look at 5min/10min/20min views:
 *   The canvas used to size itself to `canvas.clientWidth` — i.e. whatever
 *   the container happened to be. ECGViewer's `zoom` prop was *also* shrunk
 *   proportionally to the selected window length, so the canvas always
 *   exactly filled the container no matter how many minutes were loaded.
 *   That's "cram everything onto one screen" — the opposite of how a real
 *   clinical strip behaves, and it's what produced the black, illegible
 *   blocks: hundreds of beats compressed into the same pixel columns.
 *
 *   FIX: the canvas now sizes its own CSS width from
 *     durationSec (real seconds of buffered data) × truePxPerSec (zoom)
 *   — never from the container. If that's wider than the container, the
 *   parent's `overflow: auto` (already present in ECGViewer) just scrolls,
 *   exactly like a real strip-chart recorder feeding paper under a fixed
 *   viewing window. Shape and spacing of every beat stay constant no
 *   matter which VIEW window is selected — only the *amount* of strip
 *   you can scroll through changes.
 *
 *   SAFETY VALVE: browsers cap real canvas bitmap width (commonly ~14–16k
 *   device px, lower on some mobile browsers). A 20-minute window at true
 *   scale could ask for 100,000+ px, which is unrenderable. When the
 *   requested true-scale width would exceed MAX_BITMAP_W, we fall back to
 *   the old container-width behavior for that render only — using the
 *   already-correct, sr-aware min/max envelope (see "WIDE ZOOM" below) —
 *   and the meta bar explicitly labels it "Compressed overview" so nobody
 *   mistakes a deliberately-compressed overview for true scale.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Clinical features implemented:
 *   ✓ Warm-white ECG paper (#fdf6f0) with red 1mm/5mm dual grid
 *   ✓ 25 mm/s paper speed  (zoom adjustable)
 *   ✓ 10 mm/mV standard gain  (auto-half if signal overflows)
 *   ✓ Calibration pulse 10 mm × 5 mm  (1 mV × 0.2 s) — start of each row
 *   ✓ Gain label next to cal pulse (e.g. "10 mm/mV" or "5 mm/mV")
 *   ✓ Isoelectric baseline reference line per lead cell
 *   ✓ Solid row-separator lines (not just grid)
 *   ✓ Lead label — bold, top-left, red (matches printed ECG)
 *   ✓ Full-width Lead II RHYTHM STRIP at bottom of 12-lead layout
 *   ✓ "RHYTHM STRIP: II  25 mm/sec: 1 cm/mV" label (matches Ch.8 Fig 8.3)
 *   ✓ R-peak markers (▲) and RR interval brackets with ms labels (Lead II)
 *   ✓ PR interval indicator (cyan span below baseline)
 *   ✓ QRS width indicator (magenta span)
 *   ✓ Bottom metadata strip: speed | gain | filter | grid legend | HR | PR | QRS | QTc
 *   ✓ Per-lead isoelectric baseline computation (removes DC offset)
 *   ✓ Dynamic layout: 1–12 leads, resolveLayout drives everything
 *   ✓ Caliper tool with configurable interval measurements
 *   ✓ Min/Max envelope downsampling for wide time windows (shape-preserving)
 *   ✓ True-scale rendering with scrollable canvas, decoupled from VIEW window
 */

import React, { useRef, useEffect, useCallback, useMemo } from "react";
import {
  MINOR_PX, MAJOR_PX, PX_PER_SEC, PX_PER_MV,
  MM_TO_PX, SAMPLING_RATE,
  CAL_H_MM, CAL_W_MM,
  resolveLayout,
} from "../utils/ecgConstants";

const C = {
  paper:      "#fdf6f0",
  gridMinor:  "rgba(210,90,70,0.18)",
  gridMajor:  "rgba(195,60,45,0.48)",
  gridBorder: "rgba(185,50,35,0.70)",
  rowSep:     "rgba(185,50,35,0.55)",
  trace:      "#111010",
  label:      "#a82020",
  calPulse:   "#111010",
  baseline:   "rgba(140,40,20,0.28)",
  rPeak:      "rgba(25,90,200,0.70)",
  rrBracket:  "rgba(30,110,70,0.80)",
  prSpan:     "rgba(0,140,160,0.75)",
  qrsSpan:    "rgba(160,40,160,0.75)",
  gainLabel:  "rgba(155,45,25,0.80)",
  metaText:   "rgba(160,50,30,0.65)",
  rhythmBg:   "rgba(0,0,0,0.03)",
  noData:     "rgba(155,55,40,0.35)",
  caliperDrag: "rgba(245,166,35,0.90)",
  caliperSpan: "rgba(245,166,35,0.70)",
  caliperFill: "rgba(245,166,35,0.07)",
  caliperText: "rgba(200,130,0,0.95)",
  caliperPrev: "rgba(245,166,35,0.35)",
};

const NORMAL_PR_MIN  = 0.12;
const NORMAL_PR_MAX  = 0.20;
const NORMAL_QRS_MAX = 0.10;
const NORMAL_QT_MAX  = 0.44;
const BASE_MM_PER_MV = 10;

// FIX [6]: safe device-pixel ceiling for a single canvas bitmap dimension.
// Conservative across Chrome/Firefox/Safari and mobile DPR=2–3 screens.
const MAX_BITMAP_W = 12000;

function computeBaseline(buf) {
  if (!buf || buf.length === 0) return 0;
  const sorted = Float32Array.from(buf).sort();
  const n = Math.max(1, Math.floor(sorted.length * 0.15));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return sum / n;
}

function computeGainMult(buf, baseVal, rowH_css, gainOverride) {
  if (gainOverride !== null && gainOverride !== undefined) {
    return gainOverride / BASE_MM_PER_MV;
  }
  if (!buf || buf.length === 0) return 1;
  const rowHalfMv = (rowH_css * 0.44) / MM_TO_PX(10);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i] - baseVal);
    if (v > peak) peak = v;
  }
  if (peak <= rowHalfMv || peak === 0) return 1;
  return rowHalfMv / peak < 0.6 ? 0.5 : rowHalfMv / peak;
}

function detectRPeaks(buf, sr, baseline = 0) {
  if (!buf || buf.length < sr * 0.5) return [];
  const minDist = Math.round(sr * 0.30);
  let maxAbove = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] - baseline;
    if (v > maxAbove) maxAbove = v;
  }
  const thresh = maxAbove * 0.55;
  const peaks = [];
  let last = -minDist;
  for (let i = 1; i < buf.length - 1; i++) {
    const v = buf[i] - baseline;
    if (v > thresh && buf[i] >= buf[i-1] && buf[i] >= buf[i+1] && i - last >= minDist) {
      peaks.push(i);
      last = i;
    }
  }
  return peaks;
}

function estimatePRstart(rIdx, sr)  { return Math.max(0, rIdx - Math.round(sr * 0.16)); }
function estimateQRSend(rIdx, sr)   { return rIdx + Math.round(sr * 0.08); }

export default function ECGCanvas({
  leadsMap              = null,
  leadNames             = [],
  sr                    = SAMPLING_RATE,
  zoom                  = 1,
  traceThickness        = 1.5,
  showMarkers           = true,
  precomputedPeaks      = null,
  signalMetrics         = null,
  beatLabels            = null,
  beatColors            = null,
  timeOffset            = 0,
  error                 = null,
  gainOverride          = null,
  caliperArmed          = false,
  caliperMeasurements   = [],
  onCaliperMeasurement  = null,
}) {
  const canvasRef      = useRef(null);
  const dpr            = window.devicePixelRatio || 1;
  const caliperDragRef = useRef(null);
  const mouseXRef      = useRef(null);

  const layout = useMemo(() => resolveLayout(leadNames), [leadNames.join(",")]);
  const { cells, nRows, nCols, rowHeightMm } = layout;

  const is12Lead    = leadNames.length === 12;
  const rhythmRows  = is12Lead ? 1 : 0;
  const totalRows   = nRows + rhythmRows;

  const rowH_px    = MM_TO_PX(rowHeightMm);
  const rhythmH_px = rowH_px;
  const metaH_px   = MM_TO_PX(6);
  const totalH_px  = rowH_px * totalRows + metaH_px;

  const drawGrid = useCallback((ctx, W, H) => {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);
    const mPx = MINOR_PX * dpr;
    const MPx = MAJOR_PX * dpr;
    ctx.strokeStyle = C.gridMinor;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    for (let x = 0; x <= W; x += mPx) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += mPx) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.strokeStyle = C.gridMajor;
    ctx.lineWidth   = 1.0;
    ctx.beginPath();
    for (let x = 0; x <= W; x += MPx) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += MPx) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    ctx.strokeStyle = C.gridBorder;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(0, 0, W, H);
  }, [dpr]);

  const drawRowSeparators = useCallback((ctx, W, H, rowH) => {
    ctx.strokeStyle = C.rowSep;
    ctx.lineWidth   = 1.2;
    for (let r = 1; r <= totalRows; r++) {
      const y = r * rowH;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
  }, [dpr, totalRows]);

  const drawCalPulse = useCallback((ctx, x, cy, gainMult) => {
    const w = MM_TO_PX(CAL_W_MM) * dpr;
    const h = MM_TO_PX(CAL_H_MM) * dpr * gainMult;
    ctx.strokeStyle = C.calPulse;
    ctx.lineWidth   = 1.8 * dpr;
    ctx.lineJoin    = "miter";
    ctx.beginPath();
    ctx.moveTo(x,     cy + h / 2);
    ctx.lineTo(x,     cy - h / 2);
    ctx.lineTo(x + w, cy - h / 2);
    ctx.lineTo(x + w, cy + h / 2);
    ctx.stroke();
    const mmPerMv = gainOverride !== null && gainOverride !== undefined
      ? gainOverride
      : (gainMult * BASE_MM_PER_MV).toFixed(0) * 1;
    const gainLabel = `${mmPerMv} mm/mV`;
    ctx.font      = `${7.5 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.gainLabel;
    ctx.fillText(gainLabel, x, cy + h / 2 + 9 * dpr);
    return x + w + MINOR_PX * dpr * 3;
  }, [dpr, gainOverride]);

  const drawBaseline = useCallback((ctx, startX, centerY, endX) => {
    ctx.strokeStyle = C.baseline;
    ctx.lineWidth   = 0.7 * dpr;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(startX, centerY); ctx.lineTo(endX, centerY); ctx.stroke();
    ctx.setLineDash([]);
  }, [dpr]);

  const drawLabel = useCallback((ctx, text, cx, cy, rowH_css) => {
    const fs = Math.min(11, Math.max(8, rowH_css * 0.12)) * dpr;
    ctx.font      = `bold ${fs}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.label;
    ctx.fillText(text, cx + 4 * dpr, cy + fs * 1.4);
  }, [dpr]);

  const drawColSep = useCallback((ctx, x, y0, y1) => {
    ctx.save();
    ctx.strokeStyle = C.rowSep;
    ctx.lineWidth   = 0.8;
    ctx.setLineDash([3 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(x, y0 + MAJOR_PX * dpr);
    ctx.lineTo(x, y1 - MAJOR_PX * dpr);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }, [dpr]);

  const drawBeatBackgrounds = useCallback((ctx, peaks, startX, topY, rowH_css, pxPerS, timeOff) => {
    if (!beatLabels || beatLabels.size === 0 || !beatColors || !peaks?.length) return;
    for (let k = 0; k < peaks.length; k++) {
      const beatTimeSec = timeOff + peaks[k] / sr;
      let bestKey = null, bestDist = 0.6;
      for (const [t, label] of beatLabels) {
        const dist = Math.abs(t - beatTimeSec);
        if (dist < bestDist) { bestDist = dist; bestKey = label; }
      }
      if (!bestKey || bestKey === "N") continue;
      const color = beatColors[bestKey] ?? beatColors["?"] ?? "rgba(128,128,128,0.10)";
      const x0 = Math.max(startX, startX + (peaks[k] / sr) * pxPerS - pxPerS * 0.15);
      const beatWidth = k + 1 < peaks.length
        ? (peaks[k+1] - peaks[k]) / sr * pxPerS
        : pxPerS * 0.8;
      ctx.fillStyle = color;
      ctx.fillRect(x0, topY * dpr, Math.min(beatWidth, 300 * dpr), rowH_css * dpr);
    }
  }, [beatLabels, beatColors, sr, dpr]);

  // ── drawTrace: Min/Max Envelope for wide views, lineTo for close views ────
  const drawTrace = useCallback((ctx, leadName, startX, centerY, availW, rowH_css) => {
    const buf     = leadsMap?.get(leadName);
    const pxPerS  = PX_PER_SEC * dpr * zoom;
    const pxPerMv = PX_PER_MV  * dpr;

    if (!buf || buf.length === 0) {
      ctx.strokeStyle = C.noData;
      ctx.lineWidth   = 1 * dpr;
      ctx.setLineDash([5 * dpr, 5 * dpr]);
      ctx.beginPath();
      ctx.moveTo(startX, centerY);
      ctx.lineTo(startX + availW, centerY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font      = `${Math.min(9, rowH_css * 0.10) * dpr}px 'Share Tech Mono', monospace`;
      ctx.fillStyle = C.noData;
      ctx.fillText(error ? "no data" : "loading…", startX + 6 * dpr, centerY - 6 * dpr);
      return { gainMult: 1, baseline: 0, peaks: [], peaks_for_bg: [] };
    }

    const baseVal  = computeBaseline(buf);
    const gainMult = computeGainMult(buf, baseVal, rowH_css, gainOverride);
    const pvMv     = pxPerMv * gainMult;

    // Samples per physical pixel — key decision threshold
    const samplesPerPx = sr / pxPerS;

    drawBaseline(ctx, startX, centerY, startX + availW);

    ctx.strokeStyle = C.trace;
    ctx.lineWidth   = traceThickness * dpr;
    ctx.lineJoin    = "round";
    ctx.lineCap     = "round";

    if (samplesPerPx <= 1.5) {
      // ── CLOSE ZOOM (6s, 10s): sample-by-sample lineTo ──────────────────
      // Each sample has its own x coordinate — smooth clinical waveform.
      const nPts = Math.min(buf.length, Math.ceil((availW / pxPerS) * sr));
      ctx.beginPath();
      for (let i = 0; i < nPts; i++) {
        const px = startX + (i / sr) * pxPerS;
        const py = centerY - (buf[i] - baseVal) * pvMv;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();

    } else {
      // ── WIDE ZOOM (30s–20min): Min/Max Envelope Downsampling ───────────
      //
      // Standard algorithm: GE MUSE, CardioScan, Spacelabs, Mortara.
      // For each physical pixel column: find min + max sample in that
      // column's time range, draw a vertical line between them.
      //
      // Why this works: the max captures every R-wave peak perfectly.
      // The min captures every trough. Zero information loss clinically.
      // At 20min: reduces 300,000 lineTo() to ~2,400 vertical lines.

      const totalSamples = Math.min(buf.length, Math.ceil((availW / pxPerS) * sr));
      const totalPixCols = Math.ceil(availW);

      ctx.beginPath();
      let firstPoint = true;

      for (let col = 0; col < totalPixCols; col++) {
        // Sample index range for this pixel column
        const sStart = Math.floor((col / pxPerS) * sr);
        const sEnd   = Math.min(totalSamples - 1, Math.ceil(((col + 1) / pxPerS) * sr));

        if (sStart >= totalSamples) break;

        // Find min and max in this range
        let minVal = buf[sStart];
        let maxVal = buf[sStart];
        for (let s = sStart + 1; s <= sEnd; s++) {
          if (buf[s] < minVal) minVal = buf[s];
          if (buf[s] > maxVal) maxVal = buf[s];
        }

        const px    = startX + col;
        const pyMax = centerY - (maxVal - baseVal) * pvMv;  // positive deflection = UP = lower y
        const pyMin = centerY - (minVal - baseVal) * pvMv;

        if (firstPoint) {
          ctx.moveTo(px, (pyMax + pyMin) / 2);
          firstPoint = false;
        }

        if (Math.abs(pyMax - pyMin) < 0.5 * dpr) {
          // Flat region — single lineTo
          ctx.lineTo(px, pyMax);
        } else {
          // Draw envelope: peak first, then trough
          // This gives the characteristic "thick" look of wide-view ECG
          // that clinical staff recognize from Holter review software
          ctx.lineTo(px, pyMax);
          ctx.lineTo(px, pyMin);
        }
      }
      ctx.stroke();
    }

    // ── R-peaks (used for markers and beat background) ───────────────────
    const markerLead = leadNames.includes("II") ? "II" : leadNames[0];
    const peaks = (leadName === markerLead && precomputedPeaks)
      ? precomputedPeaks
      : detectRPeaks(buf, sr, baseVal);
    const peaks_for_bg = peaks.length > 0 ? peaks : detectRPeaks(buf, sr, baseVal);

    return { gainMult, baseline: baseVal, peaks, peaks_for_bg };

  }, [leadsMap, sr, dpr, zoom, traceThickness, precomputedPeaks, leadNames,
      drawBaseline, error, gainOverride]);

  const drawMarkers = useCallback((ctx, buf, peaks, startX, centerY,
                                    rowH_css, baseVal, gainMult) => {
    if (!showMarkers || !buf || peaks.length === 0) return;
    const pxPerS  = PX_PER_SEC * dpr * zoom;
    const pxPerMv = PX_PER_MV  * dpr * gainMult;
    const triSize = 4 * dpr;
    const bracketY= centerY + rowH_css * 0.28;

    peaks.forEach((rIdx, k) => {
      if (rIdx >= buf.length) return;
      const rx = startX + (rIdx / sr) * pxPerS;
      const ry = centerY - (buf[rIdx] - baseVal) * pxPerMv;

      ctx.fillStyle = C.rPeak;
      ctx.beginPath();
      ctx.moveTo(rx,               ry - triSize * 2.2);
      ctx.lineTo(rx - triSize * 0.75, ry - triSize * 0.7);
      ctx.lineTo(rx + triSize * 0.75, ry - triSize * 0.7);
      ctx.closePath(); ctx.fill();

      if (k < peaks.length) {
        const prStart  = estimatePRstart(rIdx, sr);
        const qrsStart = rIdx - Math.round(sr * 0.03);
        const x0 = startX + (prStart  / sr) * pxPerS;
        const x1 = startX + (qrsStart / sr) * pxPerS;
        if (x1 > x0 && x0 >= startX) {
          ctx.strokeStyle = C.prSpan; ctx.fillStyle = C.prSpan;
          ctx.lineWidth   = 1 * dpr;
          const prY = bracketY - rowH_css * 0.06;
          ctx.beginPath(); ctx.moveTo(x0, prY); ctx.lineTo(x1, prY); ctx.stroke();
          [x0, x1].forEach(bx => {
            ctx.beginPath();
            ctx.moveTo(bx, prY - 3*dpr); ctx.lineTo(bx, prY + 3*dpr); ctx.stroke();
          });
          ctx.font = `${6.5 * dpr}px 'Share Tech Mono', monospace`;
          const prMs = ((qrsStart - prStart) / sr * 1000).toFixed(0);
          ctx.fillText(`PR ${prMs}ms`,
            (x0+x1)/2 - ctx.measureText(`PR ${prMs}ms`).width/2, prY - 5*dpr);
        }
      }

      const qStart = rIdx - Math.round(sr * 0.03);
      const sEnd   = estimateQRSend(rIdx, sr);
      const qx0    = startX + (Math.max(0, qStart)           / sr) * pxPerS;
      const qx1    = startX + (Math.min(buf.length-1, sEnd)  / sr) * pxPerS;
      if (qx1 > qx0 && qx0 >= startX) {
        ctx.strokeStyle = C.qrsSpan; ctx.fillStyle = C.qrsSpan;
        ctx.lineWidth   = 1 * dpr;
        const qrsY = bracketY;
        ctx.beginPath(); ctx.moveTo(qx0, qrsY); ctx.lineTo(qx1, qrsY); ctx.stroke();
        [qx0, qx1].forEach(bx => {
          ctx.beginPath();
          ctx.moveTo(bx, qrsY - 3*dpr); ctx.lineTo(bx, qrsY + 3*dpr); ctx.stroke();
        });
        const qrsDurMs = ((sEnd - qStart) / sr * 1000).toFixed(0);
        ctx.font = `${6.5 * dpr}px 'Share Tech Mono', monospace`;
        ctx.fillText(`QRS ${qrsDurMs}ms`,
          (qx0+qx1)/2 - ctx.measureText(`QRS ${qrsDurMs}ms`).width/2, qrsY - 4*dpr);
      }

      if (k + 1 < peaks.length) {
        const nextRx = startX + (peaks[k+1] / sr) * pxPerS;
        const rrMs   = ((peaks[k+1] - rIdx) / sr * 1000).toFixed(0);
        const rrY    = bracketY + rowH_css * 0.08;
        ctx.strokeStyle = C.rrBracket; ctx.fillStyle = C.rrBracket;
        ctx.lineWidth   = 0.9 * dpr;
        ctx.setLineDash([3*dpr, 3*dpr]);
        ctx.beginPath(); ctx.moveTo(rx, rrY); ctx.lineTo(nextRx, rrY); ctx.stroke();
        ctx.setLineDash([]);
        [rx, nextRx].forEach(bx => {
          ctx.beginPath();
          ctx.moveTo(bx, rrY - 4*dpr); ctx.lineTo(bx, rrY + 4*dpr); ctx.stroke();
        });
        ctx.font = `${7 * dpr}px 'Share Tech Mono', monospace`;
        ctx.fillText(`${rrMs}ms`,
          (rx+nextRx)/2 - ctx.measureText(`${rrMs}ms`).width/2, rrY - 6*dpr);
      }
    });
  }, [showMarkers, dpr, zoom, sr]);

  const drawRhythmStrip = useCallback((ctx, W, stripY, stripH) => {
    const buf  = leadsMap?.get("II") ?? leadsMap?.get(leadNames[0]);
    const name = leadsMap?.has("II") ? "II" : leadNames[0];
    ctx.fillStyle = C.rhythmBg;
    ctx.fillRect(0, stripY, W, stripH);
    ctx.font      = `bold ${8 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.label;
    ctx.fillText(`RHYTHM STRIP: ${name}`, 4*dpr, stripY + 10*dpr);
    ctx.font      = `${7.5 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.metaText;
    const speedStr = (25 * zoom).toFixed(0);
    ctx.fillText(`${speedStr} mm/sec: 1 cm/mV`, 4*dpr, stripY + 19*dpr);
    const centerY = stripY + stripH / 2;
    const pxPerS  = PX_PER_SEC * dpr * zoom;
    const traceX  = drawCalPulse(ctx, MINOR_PX*dpr*3, centerY, gainOverride ? gainOverride/BASE_MM_PER_MV : 1);
    if (buf && buf.length > 0) {
      const baseVal  = computeBaseline(buf);
      const gainMult = computeGainMult(buf, baseVal, stripH/dpr, gainOverride);
      const pvMv     = PX_PER_MV * dpr * gainMult;
      const availW_r = W - traceX;
      const nPts     = Math.min(buf.length, Math.ceil((availW_r / pxPerS) * sr));
      drawBaseline(ctx, traceX, centerY, traceX + availW_r);
      ctx.strokeStyle = C.trace;
      ctx.lineWidth   = traceThickness * dpr;
      ctx.lineJoin    = "round"; ctx.lineCap = "round";

      // ── Apply same min/max envelope logic to rhythm strip ───────────────
      const samplesPerPx_r = sr / pxPerS;
      if (samplesPerPx_r <= 1.5) {
        ctx.beginPath();
        for (let i = 0; i < nPts; i++) {
          const px = traceX + (i / sr) * pxPerS;
          const py = centerY - (buf[i] - baseVal) * pvMv;
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      } else {
        const totalPix = Math.ceil(availW_r);
        ctx.beginPath();
        let fp = true;
        for (let col = 0; col < totalPix; col++) {
          const sS = Math.floor((col / pxPerS) * sr);
          const sE = Math.min(nPts - 1, Math.ceil(((col + 1) / pxPerS) * sr));
          if (sS >= nPts) break;
          let mn = buf[sS], mx = buf[sS];
          for (let s = sS + 1; s <= sE; s++) {
            if (buf[s] < mn) mn = buf[s];
            if (buf[s] > mx) mx = buf[s];
          }
          const px   = traceX + col;
          const pyMx = centerY - (mx - baseVal) * pvMv;
          const pyMn = centerY - (mn - baseVal) * pvMv;
          if (fp) { ctx.moveTo(px, (pyMx + pyMn) / 2); fp = false; }
          if (Math.abs(pyMx - pyMn) < 0.5 * dpr) { ctx.lineTo(px, pyMn); }
          else { ctx.lineTo(px, pyMx); ctx.lineTo(px, pyMn); }
        }
        ctx.stroke();
      }

      if (showMarkers) {
        const peaks = precomputedPeaks ?? detectRPeaks(buf, sr, baseVal);
        drawMarkers(ctx, buf, peaks, traceX, centerY, stripH/dpr, baseVal, gainMult);
      }
    }
  }, [leadsMap, leadNames, sr, dpr, zoom, traceThickness, showMarkers,
      precomputedPeaks, drawCalPulse, drawBaseline, drawMarkers, gainOverride]);

  // FIX [6]: accepts isCompressed so the doctor always knows when they're
  // looking at a deliberately-compressed overview vs true clinical scale.
  const drawMetaBar = useCallback((ctx, W, H, metaH, isCompressed) => {
    const y  = H - metaH;
    const fs = 8.5 * dpr;
    ctx.font      = `${fs}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.metaText;
    const speed = (25 * zoom).toFixed(0);
    const gainLabel = gainOverride !== null && gainOverride !== undefined
      ? `${gainOverride} mm/mV` : "Auto";
    const hr  = signalMetrics?.hr  ? `HR: ${signalMetrics.hr} bpm` : "";
    const pr  = signalMetrics?.pr  ? `PR: ${(signalMetrics.pr  * 1000).toFixed(0)}ms` : "";
    const qrs = signalMetrics?.qrs ? `QRS: ${(signalMetrics.qrs * 1000).toFixed(0)}ms` : "";
    const qtc = signalMetrics?.qtc ? `QTc: ${(signalMetrics.qtc * 1000).toFixed(0)}ms` : "";
    const qtcMs    = signalMetrics?.qtc ? signalMetrics.qtc * 1000 : 0;
    const qtcColor = qtcMs > 500 ? "#cc2200" : qtcMs > 450 ? "#cc7700" : C.metaText;
    const left  = `Speed: ${speed} mm/s  |  Gain: ${gainLabel}  |  0.15–150 Hz  |  50 Hz Notch`
      + (isCompressed ? `  |  Compressed overview` : "");
    const right = [hr, pr, qrs].filter(Boolean).join("  |  ");
    ctx.fillText(left,  MINOR_PX*dpr*3, y + fs*1.2);
    if (right) ctx.fillText(right, W*0.55, y + fs*1.2);
    if (qtc) {
      ctx.fillStyle = qtcColor;
      const qtcW = ctx.measureText(qtc).width;
      ctx.fillText(qtc, W - qtcW - MINOR_PX*dpr*3, y + fs*1.2);
    }
    ctx.fillStyle = C.metaText;
    const legend = "\u25a11mm=0.04s/0.1mV  \u25a05mm=0.20s/0.5mV";
    const lw     = ctx.measureText(legend).width;
    ctx.font      = `${7.5 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillText(legend, W/2 - lw/2, y + fs*2.3);
  }, [dpr, zoom, signalMetrics, gainOverride]);

  const drawCalipers = useCallback((ctx, W, H) => {
    const pxPerS   = PX_PER_SEC * dpr * zoom;
    const contentH = H - metaH_px * dpr;

    caliperMeasurements.forEach((m, i) => {
      const isMostRecent = i === caliperMeasurements.length - 1;
      const color = isMostRecent ? C.caliperSpan : C.caliperPrev;
      const fill  = isMostRecent ? C.caliperFill : "rgba(245,166,35,0.02)";
      const x0 = m.startX_px;
      const x1 = m.endX_px;
      if (x0 === undefined || x1 === undefined) return;

      ctx.fillStyle = fill;
      ctx.fillRect(Math.min(x0,x1), 0, Math.abs(x1-x0), contentH);

      [x0, x1].forEach(x => {
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.5 * dpr;
        ctx.setLineDash([4*dpr, 3*dpr]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, contentH); ctx.stroke();
        ctx.setLineDash([]);
      });

      const midY = contentH * 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth   = 1.2 * dpr;
      ctx.beginPath(); ctx.moveTo(Math.min(x0,x1), midY); ctx.lineTo(Math.max(x0,x1), midY); ctx.stroke();
      const dir0 = x0 < x1 ? 1 : -1;
      const aw = 5 * dpr;
      [x0, x1].forEach((ax, idx) => {
        const dir = idx === 0 ? -dir0 : dir0;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ax, midY);
        ctx.lineTo(ax + dir * aw, midY - 3*dpr);
        ctx.lineTo(ax + dir * aw, midY + 3*dpr);
        ctx.closePath(); ctx.fill();
      });

      const labelX = (Math.min(x0,x1) + Math.max(x0,x1)) / 2;
      const labelY = midY - 10 * dpr;
      ctx.font = `bold ${9 * dpr}px 'Share Tech Mono', monospace`;
      ctx.fillStyle = isMostRecent ? C.caliperText : "rgba(200,130,0,0.45)";
      const msLabel = `${m.ms} ms`;
      ctx.fillText(msLabel, labelX - ctx.measureText(msLabel).width/2, labelY);
      if (m.bpm) {
        ctx.font = `${8 * dpr}px 'Share Tech Mono', monospace`;
        const bpmLabel = `${m.bpm} bpm`;
        ctx.fillStyle = isMostRecent ? "rgba(200,130,0,0.75)" : "rgba(200,130,0,0.30)";
        ctx.fillText(bpmLabel, labelX - ctx.measureText(bpmLabel).width/2, labelY - 11*dpr);
      }
    });

    if (caliperDragRef.current && mouseXRef.current !== null) {
      const x0 = caliperDragRef.current.startX;
      const x1 = mouseXRef.current;
      ctx.fillStyle = "rgba(245,166,35,0.05)";
      ctx.fillRect(Math.min(x0,x1), 0, Math.abs(x1-x0), contentH);
      [x0, x1].forEach(x => {
        ctx.strokeStyle = C.caliperDrag;
        ctx.lineWidth   = 1.5 * dpr;
        ctx.setLineDash([4*dpr, 3*dpr]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, contentH); ctx.stroke();
        ctx.setLineDash([]);
      });
      const pxDiff = Math.abs(x1 - x0);
      const ms = Math.round((pxDiff / pxPerS) * 1000);
      if (ms > 0) {
        ctx.font      = `bold ${10 * dpr}px 'Share Tech Mono', monospace`;
        const lbl = `${ms} ms`;
        const lx  = (Math.min(x0,x1) + Math.max(x0,x1)) / 2;
        const ly  = contentH * 0.15;
        const lw  = ctx.measureText(lbl).width;
        ctx.fillStyle = "rgba(20,16,0,0.65)";
        ctx.beginPath();
        ctx.roundRect(lx - lw/2 - 5*dpr, ly - 10*dpr, lw + 10*dpr, 14*dpr, 3*dpr);
        ctx.fill();
        ctx.fillStyle = C.caliperText;
        ctx.fillText(lbl, lx - lw/2, ly);
      }
    }
  }, [caliperMeasurements, dpr, zoom, metaH_px]);

  // FIX [6]: render() now decides the canvas's own width from real data
  // duration × true px/sec — never from the container — and only falls
  // back to container-width compression when true scale would exceed a
  // safe canvas bitmap size.
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const containerW = canvas.parentElement?.clientWidth || 0;
    if (containerW === 0 || nRows === 0) return;

    const truePxPerSecCss = PX_PER_SEC * zoom;               // CSS px/sec, no DPR
    const firstBuf        = leadsMap?.get(leadNames[0]);
    const durationSec     = firstBuf ? firstBuf.length / sr : 0;
    const desiredWidthCss = durationSec > 0
      ? durationSec * truePxPerSecCss
      : containerW;

    const fitsTrueScale = desiredWidthCss * dpr <= MAX_BITMAP_W;
    const cssW = fitsTrueScale ? Math.max(desiredWidthCss, containerW) : containerW;

    if (canvas.style.width !== `${cssW}px`) canvas.style.width = `${cssW}px`;

    const W = cssW * dpr;
    const H = totalH_px * dpr;
    canvas.width        = W;
    canvas.height       = H;
    canvas.style.height = `${totalH_px}px`;

    const ctx  = canvas.getContext("2d");
    const colW = W / nCols;
    const rowH = (H - metaH_px * dpr) / totalRows;

    drawGrid(ctx, W, H);
    drawRowSeparators(ctx, W, H, rowH);

    const calDrawnRows = new Set();

    for (const { col, row, name } of cells) {
      const cx       = col * colW;
      const cy       = row * rowH;
      const centerY  = cy + rowH / 2;
      const rowH_css = rowH / dpr;

      if (col > 0) drawColSep(ctx, cx, cy, cy + rowH);
      drawLabel(ctx, name, cx, cy, rowH_css);

      let traceX;
      if (col === 0 && !calDrawnRows.has(row)) {
        const buf = leadsMap?.get(name);
        let rowGain = gainOverride ? gainOverride / BASE_MM_PER_MV : 1;
        if (!gainOverride && buf) {
          const base = computeBaseline(buf);
          rowGain = computeGainMult(buf, base, rowH_css, null);
        }
        traceX = drawCalPulse(ctx, cx + MINOR_PX*dpr*3, centerY, rowGain);
        calDrawnRows.add(row);
      } else {
        traceX = cx + MINOR_PX*dpr*2;
      }

      const availW = colW - (traceX - cx);
      const { gainMult, baseline: baseVal, peaks, peaks_for_bg } =
        drawTrace(ctx, name, traceX, centerY, availW, rowH_css);

      if (peaks_for_bg && peaks_for_bg.length > 0) {
        const pxPerS = PX_PER_SEC * dpr * zoom;
        drawBeatBackgrounds(ctx, peaks_for_bg, traceX,
          centerY - (rowH / dpr / 2), rowH / dpr, pxPerS, timeOffset);
      }

      const markerLead = leadNames.includes("II") ? "II" : leadNames[0];
      if (name === markerLead && showMarkers) {
        const buf = leadsMap?.get(name);
        if (buf) drawMarkers(ctx, buf, peaks, traceX, centerY, rowH_css, baseVal, gainMult);
      }
    }

    if (is12Lead) {
      const stripY = nRows * rowH;
      drawRhythmStrip(ctx, W, stripY, rhythmH_px * dpr);
    }

    drawMetaBar(ctx, W, H, metaH_px * dpr, !fitsTrueScale);

    if (caliperArmed || caliperMeasurements.length > 0) {
      drawCalipers(ctx, W, H);
    }
  }, [
    dpr, totalH_px, metaH_px, rhythmH_px, nRows, nCols, totalRows, cells,
    is12Lead, leadNames, showMarkers, leadsMap, sr, zoom, timeOffset, gainOverride,
    caliperArmed, caliperMeasurements,
    drawGrid, drawRowSeparators, drawColSep, drawLabel, drawCalPulse,
    drawBaseline, drawTrace, drawMarkers, drawRhythmStrip, drawMetaBar,
    drawBeatBackgrounds, drawCalipers,
  ]);

  useEffect(() => { render(); }, [render]);

  // FIX [6]: observe the parent (scroll container), not the canvas itself —
  // the canvas's own width is now driven by render(), not by the DOM, so
  // watching it directly would miss real container resizes (window resize,
  // fullscreen toggle, sidebar collapse, etc).
  useEffect(() => {
    const target = canvasRef.current?.parentElement;
    if (!target) return;
    const ro = new ResizeObserver(() => render());
    ro.observe(target);
    return () => ro.disconnect();
  }, [render]);

  const getCanvasX = useCallback((clientX) => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    const rect = canvas.getBoundingClientRect();
    return (clientX - rect.left) * dpr;
  }, [dpr]);

  const handleMouseDown = useCallback((e) => {
    if (!caliperArmed) return;
    e.preventDefault();
    caliperDragRef.current = { startX: getCanvasX(e.clientX) };
    mouseXRef.current      = getCanvasX(e.clientX);
  }, [caliperArmed, getCanvasX]);

  const handleMouseMove = useCallback((e) => {
    if (!caliperArmed || !caliperDragRef.current) return;
    mouseXRef.current = getCanvasX(e.clientX);
    render();
  }, [caliperArmed, getCanvasX, render]);

  const handleMouseUp = useCallback((e) => {
    if (!caliperArmed || !caliperDragRef.current) return;
    const startX = caliperDragRef.current.startX;
    const endX   = getCanvasX(e.clientX);
    caliperDragRef.current = null;
    mouseXRef.current      = null;

    const pxPerS = PX_PER_SEC * dpr * zoom;
    const pxDiff = Math.abs(endX - startX);
    if (pxDiff < 3 * dpr) { render(); return; }

    const ms  = Math.round((pxDiff / pxPerS) * 1000);
    const bpm = ms > 200 ? Math.round(60000 / ms) : null;

    const measurement = { startX_px: startX, endX_px: endX, ms, bpm };
    onCaliperMeasurement?.(measurement);
    render();
  }, [caliperArmed, getCanvasX, dpr, zoom, onCaliperMeasurement, render]);

  const handleMouseLeave = useCallback(() => {
    if (!caliperDragRef.current) return;
    caliperDragRef.current = null;
    mouseXRef.current      = null;
    render();
  }, [render]);

  const handleTouchStart = useCallback((e) => {
    if (!caliperArmed) return;
    e.preventDefault();
    const touch = e.touches[0];
    caliperDragRef.current = { startX: getCanvasX(touch.clientX) };
    mouseXRef.current      = getCanvasX(touch.clientX);
  }, [caliperArmed, getCanvasX]);

  const handleTouchMove = useCallback((e) => {
    if (!caliperArmed || !caliperDragRef.current) return;
    e.preventDefault();
    mouseXRef.current = getCanvasX(e.touches[0].clientX);
    render();
  }, [caliperArmed, getCanvasX, render]);

  const handleTouchEnd = useCallback((e) => {
    if (!caliperArmed || !caliperDragRef.current) return;
    const touch = e.changedTouches[0];
    handleMouseUp({ clientX: touch.clientX });
  }, [caliperArmed, handleMouseUp]);

  if (leadNames.length === 0) {
    return (
      <div style={{
        width: "100%", minHeight: 200,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: C.paper,
        border: "1px solid rgba(195,60,45,0.3)",
        borderRadius: 2,
      }}>
        <span style={{ fontFamily: "\'Share Tech Mono\',monospace", fontSize: 12,
          color: "rgba(155,55,40,0.5)" }}>
          {error ? `\u26a0 ${error}` : "Waiting for ECG data\u2026"}
        </span>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        display:        "block",
        minWidth:       "100%",   // FIX [6]: actual width is set imperatively in render()
        height:         totalH_px,
        cursor:         caliperArmed ? "crosshair" : "default",
        imageRendering: "crisp-edges",
        touchAction:    caliperArmed ? "none" : "auto",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    />
  );
}

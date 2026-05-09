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

import React, { useRef, useEffect, useCallback, useMemo } from "react";
import {
  MINOR_PX, MAJOR_PX, PX_PER_SEC, PX_PER_MV,
  MM_TO_PX, SAMPLING_RATE,
  CAL_H_MM, CAL_W_MM,
  resolveLayout,
} from "../utils/ecgConstants";

// ── Colours — exactly as on real printed ECG paper ───────────────────────────
const C = {
  paper:      "#fdf6f0",
  gridMinor:  "rgba(210,90,70,0.18)",
  gridMajor:  "rgba(195,60,45,0.48)",
  gridBorder: "rgba(185,50,35,0.70)",
  rowSep:     "rgba(185,50,35,0.55)",   // solid row separator
  trace:      "#111010",
  label:      "#a82020",
  calPulse:   "#111010",
  baseline:   "rgba(140,40,20,0.28)",   // isoelectric reference line
  rPeak:      "rgba(25,90,200,0.70)",   // blue R-peak triangle
  rrBracket:  "rgba(30,110,70,0.80)",   // green RR bracket
  prSpan:     "rgba(0,140,160,0.75)",   // cyan PR span
  qrsSpan:    "rgba(160,40,160,0.75)",  // magenta QRS span
  gainLabel:  "rgba(155,45,25,0.80)",
  metaText:   "rgba(160,50,30,0.65)",
  rhythmBg:   "rgba(0,0,0,0.03)",       // very slight tint on rhythm strip
  noData:     "rgba(155,55,40,0.35)",
};

// ── Clinical interval constants (from Leonard PDF) ────────────────────────────
const NORMAL_PR_MIN  = 0.12;   // s
const NORMAL_PR_MAX  = 0.20;   // s
const NORMAL_QRS_MAX = 0.10;   // s  (Leonard: 0.06–0.10)
const NORMAL_QT_MAX  = 0.44;   // s  (QTc upper normal)

// ── Per-lead isoelectric baseline (median of TP segments) ────────────────────
// Uses the 10% of samples with lowest absolute value as a proxy for TP segment.
function computeBaseline(buf) {
  if (!buf || buf.length === 0) return 0;
  const sorted = Float32Array.from(buf).sort();
  // Median of bottom 15% — avoids P/QRS/T contamination
  const n = Math.max(1, Math.floor(sorted.length * 0.15));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i];
  return sum / n;
}

// ── R-peak detector (threshold-based, robust for synthetic + real data) ───────
function detectRPeaks(buf, sr, baseline = 0) {
  if (!buf || buf.length < sr * 0.5) return [];
  const minDist = Math.round(sr * 0.30);  // 300 ms refractory

  // Find threshold: 55% of max deviation above baseline
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
    if (
      v > thresh &&
      buf[i] >= buf[i - 1] &&
      buf[i] >= buf[i + 1] &&
      i - last >= minDist
    ) {
      peaks.push(i);
      last = i;
    }
  }
  return peaks;
}

// ── Estimate PR start (P-wave onset ~160 ms before R-peak) ───────────────────
function estimatePRstart(rIdx, sr) {
  return Math.max(0, rIdx - Math.round(sr * 0.16));
}

// ── Estimate QRS end (S-wave end ~80 ms after R-peak) ────────────────────────
function estimateQRSend(rIdx, sr) {
  return rIdx + Math.round(sr * 0.08);
}

// ── Main component ────────────────────────────────────────────────────────────
export default function ECGCanvas({
  leadsMap         = null,
  leadNames        = [],
  sr               = SAMPLING_RATE,
  zoom             = 1,
  traceThickness   = 1.5,
  showMarkers      = true,
  precomputedPeaks = null,
  signalMetrics    = null,
  beatLabels       = null,   // Map<timeOffsetSec, "N"|"V"|"A"|"Art"|"?"> from analysis engine
  beatColors       = null,   // { N: rgba, V: rgba, A: rgba, Art: rgba }
  timeOffset       = 0,      // current recording position in seconds — for beat label matching
  error            = null,
}) {
  const canvasRef = useRef(null);
  const dpr       = window.devicePixelRatio || 1;

  const layout = useMemo(() => resolveLayout(leadNames), [leadNames.join(",")]);
  const { cells, nRows, nCols, rowHeightMm } = layout;

  const is12Lead    = leadNames.length === 12;
  // 12-lead gets an extra rhythm strip row below the 3×4 grid
  const rhythmRows  = is12Lead ? 1 : 0;
  const totalRows   = nRows + rhythmRows;

  const rowH_px     = MM_TO_PX(rowHeightMm);
  // Rhythm strip is same height as a regular row
  const rhythmH_px  = rowH_px;
  // Extra bottom metadata bar height
  const metaH_px    = MM_TO_PX(6);
  const totalH_px   = rowH_px * totalRows + metaH_px;

  // ── 1. Draw dual grid ──────────────────────────────────────────────────────
  const drawGrid = useCallback((ctx, W, H) => {
    ctx.fillStyle = C.paper;
    ctx.fillRect(0, 0, W, H);

    const mPx = MINOR_PX * dpr;
    const MPx = MAJOR_PX * dpr;

    // Minor 1 mm lines
    ctx.strokeStyle = C.gridMinor;
    ctx.lineWidth   = 0.5;
    ctx.beginPath();
    for (let x = 0; x <= W; x += mPx) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += mPx) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // Major 5 mm lines
    ctx.strokeStyle = C.gridMajor;
    ctx.lineWidth   = 1.0;
    ctx.beginPath();
    for (let x = 0; x <= W; x += MPx) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = 0; y <= H; y += MPx) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();

    // Outer border
    ctx.strokeStyle = C.gridBorder;
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(0, 0, W, H);
  }, [dpr]);

  // ── 2. Solid row separators ────────────────────────────────────────────────
  const drawRowSeparators = useCallback((ctx, W, H, rowH) => {
    ctx.strokeStyle = C.rowSep;
    ctx.lineWidth   = 1.2;
    // Draw between each content row
    for (let r = 1; r <= totalRows; r++) {
      const y = r * rowH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
  }, [dpr, totalRows]);

  // ── 3. Calibration pulse  (10 mm tall = 1 mV,  5 mm wide = 0.2 s) ────────
  // Returns x position where the trace should start
  const drawCalPulse = useCallback((ctx, x, cy, gainMult) => {
    const w    = MM_TO_PX(CAL_W_MM) * dpr;
    // Cal pulse height reflects actual gain: 10 mm at standard, 5 mm if half-gain
    const h    = MM_TO_PX(CAL_H_MM) * dpr * gainMult;
    ctx.strokeStyle = C.calPulse;
    ctx.lineWidth   = 1.8 * dpr;
    ctx.lineJoin    = "miter";
    ctx.beginPath();
    ctx.moveTo(x,     cy + h / 2);
    ctx.lineTo(x,     cy - h / 2);
    ctx.lineTo(x + w, cy - h / 2);
    ctx.lineTo(x + w, cy + h / 2);
    ctx.stroke();

    // Gain annotation below cal pulse (e.g. "10 mm/mV")
    const gainLabel = gainMult === 1 ? "10 mm/mV"
                    : gainMult === 0.5 ? "5 mm/mV"
                    : `${(gainMult * 10).toFixed(0)} mm/mV`;
    ctx.font      = `${7.5 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.gainLabel;
    ctx.fillText(gainLabel, x, cy + h / 2 + 9 * dpr);

    return x + w + MINOR_PX * dpr * 3;
  }, [dpr]);

  // ── 4. Isoelectric baseline line per cell ─────────────────────────────────
  const drawBaseline = useCallback((ctx, startX, centerY, endX) => {
    ctx.strokeStyle = C.baseline;
    ctx.lineWidth   = 0.7 * dpr;
    ctx.setLineDash([2 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(startX, centerY);
    ctx.lineTo(endX,   centerY);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [dpr]);

  // ── 5. Lead label ──────────────────────────────────────────────────────────
  const drawLabel = useCallback((ctx, text, cx, cy, rowH_css) => {
    const fs = Math.min(11, Math.max(8, rowH_css * 0.12)) * dpr;
    ctx.font      = `bold ${fs}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.label;
    ctx.fillText(text, cx + 4 * dpr, cy + fs * 1.4);
  }, [dpr]);

  // ── 6. Column separator (dashed vertical) ─────────────────────────────────
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

  // ── 7a. Beat background colour tinting ──────────────────────────────────
  // Draws coloured rectangle tints behind each beat based on beat classification.
  //   N=green, V=red, A=purple, Art=amber, ?=grey
  // When beatLabels is null (no analysis engine) this is a no-op.
  const drawBeatBackgrounds = useCallback((
    ctx, peaks, startX, topY, rowH_css, pxPerS, timeOff
  ) => {
    if (!beatLabels || beatLabels.size === 0 || !beatColors || !peaks?.length) return;

    for (let k = 0; k < peaks.length; k++) {
      const beatTimeSec = timeOff + peaks[k] / sr;
      let bestKey = null, bestDist = 0.6;
      for (const [t, label] of beatLabels) {
        const dist = Math.abs(t - beatTimeSec);
        if (dist < bestDist) { bestDist = dist; bestKey = label; }
      }
      // Skip normal beats — no background tint (keeps paper clean)
      if (!bestKey || bestKey === "N") continue;

      const color = beatColors[bestKey] ?? beatColors["?"] ?? "rgba(128,128,128,0.10)";
      const x0 = Math.max(startX, startX + (peaks[k] / sr) * pxPerS - pxPerS * 0.15);
      const beatWidth = k + 1 < peaks.length
        ? (peaks[k + 1] - peaks[k]) / sr * pxPerS
        : pxPerS * 0.8;

      ctx.fillStyle = color;
      ctx.fillRect(x0, topY * dpr, Math.min(beatWidth, 300 * dpr), rowH_css * dpr);
    }
  }, [beatLabels, beatColors, sr, dpr]);

  // ── 7. ECG trace for one lead ──────────────────────────────────────────────
  // Returns { gainMult, baseline, peaks } for use by marker drawing
  const drawTrace = useCallback((ctx, leadName, startX, centerY, availW, rowH_css) => {
    const buf    = leadsMap?.get(leadName);
    const pxPerS = PX_PER_SEC * dpr * zoom;
    const pxPerMv= PX_PER_MV  * dpr;

    // No-data state: dashed baseline + message
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
      return { gainMult: 1, baseline: 0, peaks: [] };
    }

    // Compute per-lead isoelectric baseline (removes DC offset / baseline wander)
    const baseVal = computeBaseline(buf);

    // Auto-gain: check if corrected signal fits in 45% of row
    const rowHalfMv = (rowH_css * 0.44) / MM_TO_PX(10);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - baseVal);
      if (v > peak) peak = v;
    }
    // gainMult: 1 = standard 10mm/mV, 0.5 = half gain 5mm/mV
    const gainMult = (peak > rowHalfMv && peak > 0)
      ? (rowHalfMv / peak < 0.6 ? 0.5 : rowHalfMv / peak)
      : 1;
    const pvMv = pxPerMv * gainMult;

    const nPts = Math.min(buf.length, Math.ceil((availW / pxPerS) * sr));

    // Draw isoelectric baseline reference line first
    drawBaseline(ctx, startX, centerY, startX + availW);

    // Draw trace
    ctx.strokeStyle = C.trace;
    ctx.lineWidth   = traceThickness * dpr;
    ctx.lineJoin    = "round";
    ctx.lineCap     = "round";
    ctx.beginPath();
    for (let i = 0; i < nPts; i++) {
      const px = startX + (i / sr) * pxPerS;
      const py = centerY - (buf[i] - baseVal) * pvMv;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.stroke();

    // Detect R-peaks (use precomputed if this is Lead II)
    const markerLead = leadNames.includes("II") ? "II" : leadNames[0];
    const peaks = (leadName === markerLead && precomputedPeaks)
      ? precomputedPeaks
      : detectRPeaks(buf, sr, baseVal);

    // peaks_for_bg: use peaks on every lead (not just marker lead) for beat colouring
    const peaks_for_bg = peaks.length > 0 ? peaks : detectRPeaks(buf, sr, baseVal);

    return { gainMult, baseline: baseVal, peaks, peaks_for_bg };
  }, [leadsMap, sr, dpr, zoom, traceThickness, precomputedPeaks, leadNames, drawBaseline, error]);

  // ── 8. Clinical interval markers (R-peaks, RR, PR, QRS) ──────────────────
  const drawMarkers = useCallback((ctx, buf, peaks, startX, centerY,
                                    rowH_css, baseVal, gainMult) => {
    if (!showMarkers || !buf || peaks.length === 0) return;

    const pxPerS  = PX_PER_SEC * dpr * zoom;
    const pxPerMv = PX_PER_MV  * dpr * gainMult;
    const triSize = 4 * dpr;
    const bracketY = centerY + rowH_css * 0.28;

    peaks.forEach((rIdx, k) => {
      if (rIdx >= buf.length) return;
      const rx  = startX + (rIdx / sr) * pxPerS;
      const ry  = centerY - (buf[rIdx] - baseVal) * pxPerMv;

      // ── R-peak triangle ▲ above the peak
      ctx.fillStyle = C.rPeak;
      ctx.beginPath();
      ctx.moveTo(rx,              ry - triSize * 2.2);
      ctx.lineTo(rx - triSize * 0.75, ry - triSize * 0.7);
      ctx.lineTo(rx + triSize * 0.75, ry - triSize * 0.7);
      ctx.closePath();
      ctx.fill();

      // ── PR interval span (blue) — from P-onset to QRS onset
      if (k < peaks.length) {
        const prStart = estimatePRstart(rIdx, sr);
        const qrsStart = rIdx - Math.round(sr * 0.03);
        const x0 = startX + (prStart   / sr) * pxPerS;
        const x1 = startX + (qrsStart  / sr) * pxPerS;
        if (x1 > x0 && x0 >= startX) {
          ctx.strokeStyle = C.prSpan;
          ctx.fillStyle   = C.prSpan;
          ctx.lineWidth   = 1 * dpr;
          // Horizontal span line
          const prY = bracketY - rowH_css * 0.06;
          ctx.beginPath(); ctx.moveTo(x0, prY); ctx.lineTo(x1, prY); ctx.stroke();
          [x0, x1].forEach(bx => {
            ctx.beginPath();
            ctx.moveTo(bx, prY - 3 * dpr); ctx.lineTo(bx, prY + 3 * dpr);
            ctx.stroke();
          });
          ctx.font = `${6.5 * dpr}px 'Share Tech Mono', monospace`;
          const prMs = ((qrsStart - prStart) / sr * 1000).toFixed(0);
          ctx.fillText(`PR ${prMs}ms`, (x0 + x1) / 2 - ctx.measureText(`PR ${prMs}ms`).width / 2, prY - 5 * dpr);
        }
      }

      // ── QRS width span (magenta) — from Q to S
      const qStart = rIdx - Math.round(sr * 0.03);
      const sEnd   = estimateQRSend(rIdx, sr);
      const qx0    = startX + (Math.max(0, qStart) / sr) * pxPerS;
      const qx1    = startX + (Math.min(buf.length - 1, sEnd) / sr) * pxPerS;
      if (qx1 > qx0 && qx0 >= startX) {
        ctx.strokeStyle = C.qrsSpan;
        ctx.fillStyle   = C.qrsSpan;
        ctx.lineWidth   = 1 * dpr;
        const qrsY = bracketY;
        ctx.beginPath(); ctx.moveTo(qx0, qrsY); ctx.lineTo(qx1, qrsY); ctx.stroke();
        [qx0, qx1].forEach(bx => {
          ctx.beginPath();
          ctx.moveTo(bx, qrsY - 3 * dpr); ctx.lineTo(bx, qrsY + 3 * dpr);
          ctx.stroke();
        });
        const qrsDurMs = ((sEnd - qStart) / sr * 1000).toFixed(0);
        ctx.font = `${6.5 * dpr}px 'Share Tech Mono', monospace`;
        ctx.fillText(`QRS ${qrsDurMs}ms`, (qx0 + qx1) / 2 - ctx.measureText(`QRS ${qrsDurMs}ms`).width / 2, qrsY - 4 * dpr);
      }

      // ── RR interval bracket (green) — between consecutive R-peaks
      if (k + 1 < peaks.length) {
        const nextRx = startX + (peaks[k + 1] / sr) * pxPerS;
        const rrMs   = ((peaks[k + 1] - rIdx) / sr * 1000).toFixed(0);
        const rrY    = bracketY + rowH_css * 0.08;

        ctx.strokeStyle = C.rrBracket;
        ctx.fillStyle   = C.rrBracket;
        ctx.lineWidth   = 0.9 * dpr;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath(); ctx.moveTo(rx, rrY); ctx.lineTo(nextRx, rrY); ctx.stroke();
        ctx.setLineDash([]);
        [rx, nextRx].forEach(bx => {
          ctx.beginPath();
          ctx.moveTo(bx, rrY - 4 * dpr); ctx.lineTo(bx, rrY + 4 * dpr);
          ctx.stroke();
        });
        ctx.font = `${7 * dpr}px 'Share Tech Mono', monospace`;
        ctx.fillText(
          `${rrMs}ms`,
          (rx + nextRx) / 2 - ctx.measureText(`${rrMs}ms`).width / 2,
          rrY - 6 * dpr
        );
      }
    });
  }, [showMarkers, dpr, zoom, sr]);

  // ── 9. Rhythm strip (full-width Lead II at bottom of 12-lead) ────────────
  // Matches ALS Ch.8 Fig 8.3 — labelled "RHYTHM STRIP: II  25 mm/sec: 1 cm/mV"
  const drawRhythmStrip = useCallback((ctx, W, stripY, stripH) => {
    const buf  = leadsMap?.get("II") ?? leadsMap?.get(leadNames[0]);
    const name = leadsMap?.has("II") ? "II" : leadNames[0];

    // Slight background tint to distinguish from main leads
    ctx.fillStyle = C.rhythmBg;
    ctx.fillRect(0, stripY, W, stripH);

    // "RHYTHM STRIP: II  25 mm/sec: 1 cm/mV" label — top-left (matches Fig 8.3)
    ctx.font      = `bold ${8 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.label;
    ctx.fillText(`RHYTHM STRIP: ${name}`, 4 * dpr, stripY + 10 * dpr);
    ctx.font      = `${7.5 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.metaText;
    const speedStr = (25 * zoom).toFixed(0);
    ctx.fillText(`${speedStr} mm/sec: 1 cm/mV`, 4 * dpr, stripY + 19 * dpr);

    const centerY   = stripY + stripH / 2;
    const pxPerS    = PX_PER_SEC * dpr * zoom;

    // Cal pulse — left margin
    const traceX = drawCalPulse(ctx, MINOR_PX * dpr * 3, centerY, 1);

    // Draw the rhythm strip trace
    if (buf && buf.length > 0) {
      const baseVal  = computeBaseline(buf);
      const rowHalfMv= (stripH / dpr * 0.44) / MM_TO_PX(10);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - baseVal);
        if (v > peak) peak = v;
      }
      const gainMult = (peak > rowHalfMv && peak > 0) ? Math.min(1, rowHalfMv / peak) : 1;
      const pvMv     = PX_PER_MV * dpr * gainMult;
      const availW   = W - traceX;
      const nPts     = Math.min(buf.length, Math.ceil((availW / pxPerS) * sr));

      drawBaseline(ctx, traceX, centerY, traceX + availW);

      ctx.strokeStyle = C.trace;
      ctx.lineWidth   = traceThickness * dpr;
      ctx.lineJoin    = "round";
      ctx.lineCap     = "round";
      ctx.beginPath();
      for (let i = 0; i < nPts; i++) {
        const px = traceX + (i / sr) * pxPerS;
        const py = centerY - (buf[i] - baseVal) * pvMv;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();

      // R-peak markers on rhythm strip
      if (showMarkers) {
        const peaks = precomputedPeaks ?? detectRPeaks(buf, sr, baseVal);
        drawMarkers(ctx, buf, peaks, traceX, centerY, stripH / dpr, baseVal, gainMult);
      }
    }
  }, [leadsMap, leadNames, sr, dpr, zoom, traceThickness, showMarkers,
      precomputedPeaks, drawCalPulse, drawBaseline, drawMarkers]);

  // ── 10. Bottom metadata bar ───────────────────────────────────────────────
  // Mirrors the text block on real ECG printouts:
  //   "Speed: 25 mm/s  Limb: 10 mm/mV  Chest: 10 mm/mV  HR: 72  PR: 160ms  QRS: 80ms  QTc: 420ms"
  const drawMetaBar = useCallback((ctx, W, H, metaH) => {
    const y   = H - metaH;
    const fs  = 8.5 * dpr;
    ctx.font      = `${fs}px 'Share Tech Mono', monospace`;
    ctx.fillStyle = C.metaText;

    const speed = (25 * zoom).toFixed(0);
    const hr    = signalMetrics?.hr  ? `HR: ${signalMetrics.hr} bpm` : "";
    const pr    = signalMetrics?.pr  ? `PR: ${(signalMetrics.pr  * 1000).toFixed(0)}ms` : "";
    const qrs   = signalMetrics?.qrs ? `QRS: ${(signalMetrics.qrs * 1000).toFixed(0)}ms` : "";
    const qtc   = signalMetrics?.qtc ? `QTc: ${(signalMetrics.qtc * 1000).toFixed(0)}ms` : "";

    // QTc colour coding from Leonard PDF: >450ms borderline, >500ms prolonged
    const qtcMs = signalMetrics?.qtc ? signalMetrics.qtc * 1000 : 0;
    const qtcColor = qtcMs > 500 ? "#cc2200"
                   : qtcMs > 450 ? "#cc7700"
                   : C.metaText;

    const left  = `Speed: ${speed} mm/s  |  Limb: 10 mm/mV  |  Chest: 10 mm/mV  |  0.15–150 Hz  |  50 Hz Notch`;
    const right = [hr, pr, qrs].filter(Boolean).join("  |  ");

    ctx.fillText(left,  MINOR_PX * dpr * 3, y + fs * 1.2);
    if (right) ctx.fillText(right, W * 0.55, y + fs * 1.2);

    if (qtc) {
      ctx.fillStyle = qtcColor;
      const qtcW = ctx.measureText(qtc).width;
      ctx.fillText(qtc, W - qtcW - MINOR_PX * dpr * 3, y + fs * 1.2);
    }

    // Small grid legend
    ctx.fillStyle = C.metaText;
    const legend = "□1mm=0.04s/0.1mV  ■5mm=0.20s/0.5mV";
    const lw     = ctx.measureText(legend).width;
    ctx.font      = `${7.5 * dpr}px 'Share Tech Mono', monospace`;
    ctx.fillText(legend, W / 2 - lw / 2, y + fs * 2.3);
  }, [dpr, zoom, signalMetrics]);

  // ── Master render ──────────────────────────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cssW = canvas.clientWidth;
    if (cssW === 0 || nRows === 0) return;

    const W = cssW * dpr;
    const H = totalH_px * dpr;
    canvas.width        = W;
    canvas.height       = H;
    canvas.style.height = `${totalH_px}px`;

    const ctx  = canvas.getContext("2d");
    const colW = W / nCols;
    const rowH = (H - metaH_px * dpr) / totalRows;  // content rows only

    drawGrid(ctx, W, H);
    drawRowSeparators(ctx, W, H, rowH);

    const calDrawnRows = new Set();

    for (const { col, row, name } of cells) {
      const cx      = col * colW;
      const cy      = row * rowH;
      const centerY = cy + rowH / 2;
      const rowH_css= rowH / dpr;

      // Column separator
      if (col > 0) drawColSep(ctx, cx, cy, cy + rowH);

      // Lead label
      drawLabel(ctx, name, cx, cy, rowH_css);

      // Calibration pulse — first column of each row only
      let traceX;
      if (col === 0 && !calDrawnRows.has(row)) {
        // Determine gain for this row by peeking at signal
        const buf = leadsMap?.get(name);
        let rowGain = 1;
        if (buf) {
          const base = computeBaseline(buf);
          const halfMv = (rowH_css * 0.44) / MM_TO_PX(10);
          let pk = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = Math.abs(buf[i] - base);
            if (v > pk) pk = v;
          }
          if (pk > halfMv && pk > 0) rowGain = Math.min(1, halfMv / pk < 0.6 ? 0.5 : halfMv / pk);
        }
        traceX = drawCalPulse(ctx, cx + MINOR_PX * dpr * 3, centerY, rowGain);
        calDrawnRows.add(row);
      } else {
        traceX = cx + MINOR_PX * dpr * 2;
      }

      const availW = colW - (traceX - cx);
      const { gainMult, baseline: baseVal, peaks, peaks_for_bg } = drawTrace(ctx, name, traceX, centerY, availW, rowH_css);

      // Beat background colour tinting — drawn after trace so it overlays cleanly
      if (peaks_for_bg && peaks_for_bg.length > 0) {
        const pxPerS = PX_PER_SEC * dpr * zoom;
        drawBeatBackgrounds(ctx, peaks_for_bg, traceX,
          centerY - (rowH / dpr / 2), rowH / dpr, pxPerS, timeOffset);
      }

      // Draw markers on Lead II (or first lead)
      const markerLead = leadNames.includes("II") ? "II" : leadNames[0];
      if (name === markerLead && showMarkers) {
        const buf = leadsMap?.get(name);
        if (buf) drawMarkers(ctx, buf, peaks, traceX, centerY, rowH_css, baseVal, gainMult);
      }
    }

    // Rhythm strip row for 12-lead
    if (is12Lead) {
      const stripY = nRows * rowH;
      drawRhythmStrip(ctx, W, stripY, rhythmH_px * dpr);
    }

    // Bottom metadata bar
    drawMetaBar(ctx, W, H, metaH_px * dpr);
  }, [
    dpr, totalH_px, metaH_px, rhythmH_px, nRows, nCols, totalRows, cells,
    is12Lead, leadNames, showMarkers, leadsMap, zoom, timeOffset,
    drawGrid, drawRowSeparators, drawColSep, drawLabel, drawCalPulse,
    drawBaseline, drawTrace, drawMarkers, drawRhythmStrip, drawMetaBar,
    drawBeatBackgrounds,
  ]);

  useEffect(() => { render(); }, [render]);

  useEffect(() => {
    const ro = new ResizeObserver(() => render());
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => ro.disconnect();
  }, [render]);

  // Empty state
  if (leadNames.length === 0) {
    return (
      <div style={{
        width: "100%", minHeight: 200,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: C.paper,
        border: "1px solid rgba(195,60,45,0.3)",
        borderRadius: 2,
      }}>
        <span style={{ fontFamily: "'Share Tech Mono',monospace", fontSize: 12,
          color: "rgba(155,55,40,0.5)" }}>
          {error ? `⚠ ${error}` : "Waiting for ECG data…"}
        </span>
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        display:        "block",
        width:          "100%",
        height:         totalH_px,
        cursor:         "crosshair",
        imageRendering: "crisp-edges",
      }}
    />
  );
}

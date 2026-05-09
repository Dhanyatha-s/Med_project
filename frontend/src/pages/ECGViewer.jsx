/**
 * ECGViewer.jsx  —  Dynamic lead-driven ECG viewer
 *
 * NEW in this version:
 *   • Time window selector: 6s / 10s / 30s / 1min / 2min / 5min
 *     Maps to zoom values so existing useEcgData chunking is preserved.
 *   • Beat colour state passed to ECGCanvas (N/V/A/Art colours).
 *     Currently "all Normal" — wired ready for analysis engine output.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import ECGCanvas        from "../components/ECGCanvas";
import PatientBanner    from "../components/PatientBanner";
import TimelineBar      from "../components/TimelineBar";
import LoadingOverlay   from "../components/LoadingOverlay";
import useEcgData       from "../hooks/useEcgData";
import useSignalMetrics from "../hooks/useSignalMetrics";
import { useApp }       from "../context/AppContext";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

// ── Time window presets ────────────────────────────────────────────────────────
// Each entry: { label, windowSec }
// windowSec drives the fetch duration and canvas time span.
// We derive zoom from windowSec: zoom = BASE_WINDOW_SEC / windowSec
// BASE_WINDOW_SEC = 10 (defined in useEcgData)
const BASE_WINDOW_SEC = 10;
const TIME_WINDOWS = [
  { label: "6s",    windowSec: 6   },
  { label: "10s",   windowSec: 10  },   // default
  { label: "30s",   windowSec: 30  },
  { label: "1 min", windowSec: 60  },
  { label: "2 min", windowSec: 120 },
  { label: "5 min", windowSec: 300 },
];

const DEFAULT_WINDOW_IDX = 1;   // "10s"

// ── Beat colour map ────────────────────────────────────────────────────────────
// Keys match what the analysis engine will eventually produce.
// Values are rgba colours used by ECGCanvas for background tinting.
export const BEAT_COLORS = {
  N:   "rgba(52,199,123,0.12)",    // Normal     → green
  V:   "rgba(224,80,80,0.15)",     // Ventricular→ red
  A:   "rgba(167,139,250,0.15)",   // Atrial     → purple
  Art: "rgba(245,166,35,0.13)",    // Artefact   → amber
  "?": "rgba(128,128,128,0.10)",   // Unknown    → grey
};

export default function ECGViewer({ patient, tabColor = "#4f8ef7" }) {
  const [timeOffset,   setTimeOffset]  = useState(0);
  const [playing,      setPlaying]     = useState(false);
  const [showMarkers,  setShowMarkers] = useState(true);
  const [manualHr,     setManualHr]    = useState(null);
  const [windowIdx,    setWindowIdx]   = useState(DEFAULT_WINDOW_IDX);

  // Beat labels: Map<timeOffsetSec, "N"|"V"|"A"|"Art"|"?">
  // Currently empty — will be populated by analysis engine in future phase.
  const [beatLabels, setBeatLabels] = useState(new Map());

  const { settings } = useApp();

  // Derive zoom from selected time window
  const selectedWindow = TIME_WINDOWS[windowIdx];
  const zoom = BASE_WINDOW_SEC / selectedWindow.windowSec;

  // ── Data ──────────────────────────────────────────────────────────────────
  const { leadsMap, leadNames, loading, error, totalSec, windowSec } = useEcgData(
    patient?.id, timeOffset, zoom
  );

  // ── Signal metrics ────────────────────────────────────────────────────────
  const metrics = useSignalMetrics(leadsMap, 250);
  const hr      = (metrics.hr && !manualHr) ? metrics.hr : (manualHr ?? 72);

  // ── RAF playback ──────────────────────────────────────────────────────────
  const playStartWallRef = useRef(null);
  const playStartEcgRef  = useRef(0);
  const rafRef           = useRef(null);

  const stopPlay = useCallback(() => {
    setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    playStartWallRef.current = null;
  }, []);

  useEffect(() => {
    if (!playing) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      return;
    }
    playStartWallRef.current = performance.now();
    playStartEcgRef.current  = timeOffset;

    const step = (now) => {
      const elapsed    = (now - playStartWallRef.current) / 1000;
      const nextOffset = playStartEcgRef.current + elapsed;
      if (nextOffset >= totalSec - windowSec) { stopPlay(); return; }
      setTimeOffset(nextOffset);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, totalSec]);

  if (!patient) return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ ...MONO, fontSize: 12, color: "#2a2a2a" }}>No patient selected</span>
    </div>
  );

  const leadDesc = leadNames.length === 0
    ? "detecting…"
    : `${leadNames.length}-Lead  ·  ${leadNames.join(" · ")}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1,
      overflow: "hidden", minHeight: 0 }}>

      <PatientBanner
        patient={patient}
        hr={hr}
        leadCount={leadNames.length}
        metrics={metrics}
        fromSignal={!!metrics.hr && !manualHr}
      />

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "6px 14px", background: "#0b0b0b",
        borderBottom: "1px solid #181818",
        flexShrink: 0, flexWrap: "wrap", gap: 6,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>

          {/* Lead info badge */}
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            background: "rgba(79,142,247,0.07)",
            border: "1px solid rgba(79,142,247,0.2)",
            borderRadius: 5, padding: "3px 10px",
          }}>
            <span style={{ ...MONO, fontSize: 9, color: "#4f8ef7", letterSpacing: "0.06em" }}>ECG</span>
            <span style={{ ...MONO, fontSize: 10, color: "#6a9ff7" }}>{leadDesc}</span>
          </div>

          {/* ── Time window selector ────────────────────────────────────── */}
          <div style={{
            display: "flex", alignItems: "center", gap: 2,
            paddingLeft: 8, borderLeft: "1px solid #1a1a1a",
          }}>
            <span style={{ ...MONO, fontSize: 9, color: "#333", marginRight: 4 }}>VIEW</span>
            {TIME_WINDOWS.map((w, i) => {
              const active = i === windowIdx;
              return (
                <button key={w.label}
                  onClick={() => { setWindowIdx(i); stopPlay(); }}
                  title={`Show ${w.label} of ECG at once`}
                  style={{
                    ...MONO, fontSize: 9,
                    padding: "3px 7px", cursor: "pointer", borderRadius: 3,
                    background: active ? "rgba(79,142,247,0.15)" : "transparent",
                    border: active ? "1px solid rgba(79,142,247,0.4)" : "1px solid #1e1e1e",
                    color: active ? "#4f8ef7" : "#3a3a3a",
                    transition: "all 0.1s",
                  }}>
                  {w.label}
                </button>
              );
            })}
          </div>

          {/* Markers toggle */}
          <button onClick={() => setShowMarkers(v => !v)}
            style={{
              ...MONO, fontSize: 10, cursor: "pointer", borderRadius: 4, padding: "3px 8px",
              background: showMarkers ? "rgba(79,142,247,0.1)" : "transparent",
              border: showMarkers ? "1px solid rgba(79,142,247,0.3)" : "1px solid #1e1e1e",
              color: showMarkers ? "#4f8ef7" : "#333",
            }}>
            ▲ Markers {showMarkers ? "ON" : "OFF"}
          </button>

          {/* HR source badge */}
          {metrics.hr && (
            <div style={{ paddingLeft: 8, borderLeft: "1px solid #1a1a1a",
              display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ ...MONO, fontSize: 9,
                background: "rgba(52,199,123,0.08)",
                border: "1px solid rgba(52,199,123,0.25)",
                color: "#34c77b", padding: "2px 7px", borderRadius: 3 }}>
                ⚡ HR from signal
              </span>
              <button onClick={() => setManualHr(manualHr ? null : hr)}
                style={{ ...MONO, fontSize: 9, background: "transparent",
                  border: "1px solid #1e1e1e", color: "#333",
                  borderRadius: 3, padding: "2px 6px", cursor: "pointer" }}>
                {manualHr ? "use signal" : "override"}
              </button>
            </div>
          )}

          {/* Beat colour legend — compact inline */}
          <div style={{
            paddingLeft: 8, borderLeft: "1px solid #1a1a1a",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            {[
              { key: "N",   color: "#34c77b", tip: "Normal" },
              { key: "V",   color: "#e05050", tip: "Ventricular" },
              { key: "A",   color: "#a78bfa", tip: "Atrial" },
              { key: "Art", color: "#f5a623", tip: "Artefact" },
            ].map(({ key, color, tip }) => (
              <div key={key} title={tip}
                style={{ display: "flex", alignItems: "center", gap: 3, cursor: "help" }}>
                <div style={{
                  width: 8, height: 8, borderRadius: 1,
                  background: `${color}40`, border: `1px solid ${color}`,
                }} />
                <span style={{ ...MONO, fontSize: 8, color: "#2e2e2e" }}>{key}</span>
              </div>
            ))}
            <span style={{ ...MONO, fontSize: 8, color: "#222" }}>beat types</span>
          </div>
        </div>

        {/* Status */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {error && (
            <span style={{ ...MONO, fontSize: 9, color: "#ff5040",
              background: "rgba(255,80,64,0.08)", border: "1px solid rgba(255,80,64,0.2)",
              padding: "2px 8px", borderRadius: 3, maxWidth: 260,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              ⚠ {error.split("\n")[0]}
            </span>
          )}
          <span style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%",
            background: playing ? tabColor : "#222",
            animation: playing ? "livePulse 1.1s ease-in-out infinite" : "none",
          }} />
          <span style={{ ...MONO, fontSize: 10, color: playing ? tabColor : "#2a2a2a" }}>
            {playing ? "PLAYING" : "PAUSED"}
          </span>
        </div>
      </div>

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: "auto", position: "relative",
        background: "#0c0c0c", padding: "8px 8px 0" }}>
        <LoadingOverlay visible={loading && !leadsMap} />
        <ECGCanvas
          leadsMap={leadsMap}
          leadNames={leadNames}
          sr={250}
          zoom={zoom}
          traceThickness={settings?.traceThickness ?? 1.5}
          showMarkers={showMarkers}
          precomputedPeaks={metrics.peaks}
          signalMetrics={metrics}
          beatLabels={beatLabels}
          beatColors={BEAT_COLORS}
          error={error}
        />
      </div>

      <TimelineBar
        timeOffset={timeOffset}
        setTimeOffset={t => { stopPlay(); setTimeOffset(t); }}
        totalDuration={totalSec}
        hr={hr}
        setHr={v => setManualHr(v)}
        showManualHr={!metrics.hr || !!manualHr}
        playing={playing}
        setPlaying={setPlaying}
        windowSec={windowSec}
      />

      <style>{`
        @keyframes livePulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.3; transform:scale(0.75); }
        }
      `}</style>
    </div>
  );
}

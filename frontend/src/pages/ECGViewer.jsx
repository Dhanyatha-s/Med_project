/**
 * ECGViewer.jsx  —  Dynamic lead-driven ECG viewer  (Phase 1 complete)
 * ─────────────────────────────────────────────────────────────────────────────
 * Design system: matches SettingsPage, DeviceConnect, DiaryPanel exactly.
 *   - Tabler outline icons at 15px — no emoji anywhere
 *   - MONO token for all labels, badges, status readouts
 *   - One accent color (#378ADD / blue), semantic green (#34c77b)
 *   - ToolBtn / ToolGroup use the same ghost/primary/danger pattern
 *   - Section dividers: 0.5px border, uppercase monospace label
 *   - Active toolbar states: tinted bg + matching border, no solid fills
 *
 * All functionality preserved from original:
 *  ✓ TIME_WINDOWS (6s / 10s / 30s / 1–20 min) — spec item N
 *  ✓ SPEED_OPTIONS 25 / 50 mm/s — spec N
 *  ✓ GAIN_OPTIONS 5 / 10 / 20 / Auto mm/mV
 *  ✓ Fullscreen toggle
 *  ✓ Caliper arm / disarm + measurements readout
 *  ✓ DiaryPanel slide-in
 *  ✓ PDF report generation
 *  ✓ Beat colour legend (Phase 2 ready)
 *  ✓ RAF playback loop + resyncPlayback
 *  ✓ onStateChange → App.jsx live HR/timeOffset
 *  ✓ notify prop
 *
 * Props (unchanged):
 *   patient          object
 *   tabColor         string   accent for play-state dot
 *   notify           fn
 *   onStateChange    fn
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * ECGViewer.jsx  —  Dynamic lead-driven ECG viewer  (Phase 1 complete)
 * ─────────────────────────────────────────────────────────────────────────────
 * Design system: matches SettingsPage, DeviceConnect, DiaryPanel exactly.
 *   - Tabler outline icons at 15px — no emoji anywhere
 *   - MONO token for all labels, badges, status readouts
 *   - One accent color (#378ADD / blue), semantic green (#34c77b)
 *   - ToolBtn / ToolGroup use the same ghost/primary/danger pattern
 *   - Section dividers: 0.5px border, uppercase monospace label
 *   - Active toolbar states: tinted bg + matching border, no solid fills
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIX [6] — ZOOM ADDED, DECOUPLED FROM "VIEW" WINDOW LENGTH
 *
 *   Previously: canvasZoom = (BASE_WINDOW_SEC / displayWindowSec) * speedMult
 *   This meant rendering scale shrank automatically every time a longer
 *   VIEW window was picked — "5 min" view literally compressed 5 minutes
 *   of beats into the same pixel width that "10 s" used for 10 seconds.
 *   That's what produced the illegible black/compacted strips.
 *
 *   NOW: canvasZoom = speedMult * zoomMult — a pure rendering-scale value,
 *   completely independent of which VIEW window is selected. VIEW now only
 *   controls how many seconds of real data get buffered (see useEcgData) —
 *   ECGCanvas turns that into canvas *width*, not compression, so the
 *   waveform's actual shape and beat spacing never change when you switch
 *   VIEW windows. A new ZOOM toolgroup gives genuine zoom in/out on top of
 *   the existing clinical paper-speed presets.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All functionality preserved from original:
 *  ✓ TIME_WINDOWS (6s / 10s / 30s / 1–20 min) — spec item N
 *  ✓ SPEED_OPTIONS 25 / 50 mm/s — spec N
 *  ✓ GAIN_OPTIONS 5 / 10 / 20 / Auto mm/mV
 *  ✓ Fullscreen toggle
 *  ✓ Caliper arm / disarm + measurements readout
 *  ✓ DiaryPanel slide-in
 *  ✓ PDF report generation
 *  ✓ Beat colour legend (Phase 2 ready)
 *  ✓ RAF playback loop + resyncPlayback
 *  ✓ onStateChange → App.jsx live HR/timeOffset
 *  ✓ notify prop
 *
 * Props (unchanged):
 *   patient          object
 *   tabColor         string   accent for play-state dot
 *   notify           fn
 *   onStateChange    fn
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useRef, useCallback } from "react";
import ECGCanvas        from "../components/ECGCanvas";
import PatientBanner    from "../components/PatientBanner";
import TimelineBar      from "../components/TimelineBar";
import LoadingOverlay   from "../components/LoadingOverlay";
import DiaryPanel       from "../components/DiaryPanel";
import useEcgData       from "../hooks/useEcgData";
import useSignalMetrics from "../hooks/useSignalMetrics";
import { useApp }        from "../context/AppContext";
import { getEcgTheme }   from "../styles/themeTokens";
 
// ─── Typography token ─────────────────────────────────────────────────────────
const MONO = { fontFamily: "'Share Tech Mono', 'Consolas', monospace" };
 
// ─── Time window presets ──────────────────────────────────────────────────────
// FIX [6]: these now mean "how many seconds of recording to load for review/
// scroll" — NOT "how much to compress onto one screen." 6s/10s/30s render at
// true scale and fit (or nearly fit) one screen with no scrolling needed.
// 1min+ render at the SAME true scale but produce a wider canvas you scroll
// through — like a real strip-chart, never compressed beat shapes.
const BASE_WINDOW_SEC = 10;
const TIME_WINDOWS = [
  { label: "6 s",    windowSec: 6    },
  { label: "10 s",   windowSec: 10   },
  { label: "30 s",   windowSec: 30   },
  { label: "1 min",  windowSec: 60   },
  { label: "2 min",  windowSec: 120  },
  { label: "5 min",  windowSec: 300  },
  { label: "10 min", windowSec: 600  },
  { label: "20 min", windowSec: 1200 },
];
const DEFAULT_WINDOW_IDX = 1;   // 10 s
 
// ─── Speed presets (clinical paper speed) ─────────────────────────────────────
const SPEED_OPTIONS = [
  { label: "25 mm/s", mult: 1.0 },
  { label: "50 mm/s", mult: 2.0 },
];
const DEFAULT_SPEED_IDX = 0;

// ─── Zoom presets (FIX [6]: new — genuine zoom, independent of VIEW/Speed) ───
// Multiplies on top of paper speed. 100% = standard clinical scale at the
// selected paper speed. Use this to zoom in on fine detail or zoom out for
// a quick scan, without touching the clinical-standard mm/s setting.
const ZOOM_OPTIONS = [
  { label: "50%",  mult: 0.5  },
  { label: "75%",  mult: 0.75 },
  { label: "100%", mult: 1.0  },
  { label: "150%", mult: 1.5  },
  { label: "200%", mult: 2.0  },
  { label: "300%", mult: 3.0  },
];
const DEFAULT_ZOOM_IDX = 2;   // 100%
 
// ─── Gain presets ─────────────────────────────────────────────────────────────
const GAIN_OPTIONS = [
  { label: "5 mm/mV",  mmPerMv: 5    },
  { label: "10 mm/mV", mmPerMv: 10   },
  { label: "20 mm/mV", mmPerMv: 20   },
  { label: "Auto",     mmPerMv: null },
];
const DEFAULT_GAIN_IDX = 1;   // 10 mm/mV
 
// ─── Beat colour map (Phase 2 engine will populate beatLabels) ────────────────
// Kept as fixed translucent overlays — these tint the ECG paper itself and
// are deliberately theme-independent (paper colour is constant per AppContext).
export const BEAT_COLORS = {
  N:   "rgba(52,199,123,0.12)",
  V:   "rgba(224,80,80,0.15)",
  A:   "rgba(167,139,250,0.15)",
  Art: "rgba(245,166,35,0.13)",
  "?": "rgba(128,128,128,0.10)",
};
 
// ─────────────────────────────────────────────────────────────────────────────
// Toolbar primitives
// Each accepts `T` (the theme palette from getEcgTheme) so they recolor with
// the rest of the viewer. Consistent with ghost/primary/danger button language
// across the whole app.
// ─────────────────────────────────────────────────────────────────────────────
 
/**
 * ToolBtn — ghost button for toolbar actions.
 *   active  → accent tint (or red tint for danger variant)
 *   icon    → Tabler icon class string, e.g. "ti-calendar"
 */
function ToolBtn({
  children, onClick, active, title, danger, disabled, icon, iconOnly, T,
}) {
  const activeColor  = danger ? T.red : T.accent;
  const activeBg     = danger
    ? T.withAlpha(T.red, 0.12)
    : T.withAlpha(T.accent, 0.10);
  const activeBorder = danger
    ? T.withAlpha(T.red, 0.38)
    : T.withAlpha(T.accent, 0.38);
  const hoverBorder  = danger
    ? T.withAlpha(T.red, 0.30)
    : T.withAlpha(T.accent, 0.28);
 
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      style={{
        ...MONO,
        display:      "flex",
        alignItems:   "center",
        gap:          5,
        height:       24,
        padding:      iconOnly ? "0 6px" : "0 9px",
        fontSize:     10,
        letterSpacing:"0.04em",
        cursor:       disabled ? "not-allowed" : "pointer",
        borderRadius: 4,
        opacity:      disabled ? 0.45 : 1,
        background:   active ? activeBg : "transparent",
        border:       `0.5px solid ${active ? activeBorder : T.border1}`,
        color:        active ? activeColor : T.grey1,
        transition:   "background 0.1s, color 0.1s, border-color 0.1s",
        whiteSpace:   "nowrap",
        flexShrink:   0,
      }}
      onMouseEnter={e => {
        if (!active && !disabled) {
          e.currentTarget.style.borderColor = hoverBorder;
          e.currentTarget.style.color = danger ? T.red : T.accent;
        }
      }}
      onMouseLeave={e => {
        if (!active && !disabled) {
          e.currentTarget.style.borderColor = T.border1;
          e.currentTarget.style.color = T.grey1;
        }
      }}
    >
      {icon && (
        <i
          className={`ti ${icon}`}
          style={{ fontSize: 14, flexShrink: 0 }}
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
 
/** ToolGroup — visual separator + optional label between toolbar sections */
function ToolGroup({ label, children, T }) {
  return (
    <div style={{
      display:    "flex",
      alignItems: "center",
      gap:        3,
      paddingLeft: 8,
      borderLeft: `0.5px solid ${T.border1}`,
      flexShrink: 0,
    }}>
      {label && (
        <span style={{
          ...MONO,
          fontSize:      9,
          color:         T.grey6,
          marginRight:   3,
          letterSpacing: "0.07em",
          textTransform: "uppercase",
        }}>
          {label}
        </span>
      )}
      {children}
    </div>
  );
}
 
/** ToolDivider — explicit vertical rule between unrelated sections */
function ToolDivider({ T }) {
  return (
    <div style={{
      width:      "0.5px",
      height:     14,
      background: T.border1,
      flexShrink: 0,
    }} />
  );
}
 
// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────
export default function ECGViewer({
  patient,
  tabColor,
  notify,
  onStateChange,
}) {
  const [timeOffset,          setTimeOffset]          = useState(0);
  const [playing,             setPlaying]             = useState(false);
  const [showMarkers,         setShowMarkers]         = useState(true);
  const [manualHr,            setManualHr]            = useState(null);
  const [windowIdx,           setWindowIdx]           = useState(DEFAULT_WINDOW_IDX);
  const [speedIdx,            setSpeedIdx]            = useState(DEFAULT_SPEED_IDX);
  const [zoomIdx,             setZoomIdx]             = useState(DEFAULT_ZOOM_IDX); // FIX [6]
  const [gainIdx,             setGainIdx]             = useState(DEFAULT_GAIN_IDX);
  const [isFullscreen,        setIsFullscreen]        = useState(false);
  const [caliperArmed,        setCaliperArmed]        = useState(false);
  const [caliperMeasurements, setCaliperMeasurements] = useState([]);
  const [beatLabels,          setBeatLabels]          = useState(new Map()); // eslint-disable-line
  const [diaryOpen,           setDiaryOpen]           = useState(false);
  const [diaryMarkers,        setDiaryMarkers]        = useState([]);
  const [reportLoading,       setReportLoading]       = useState(false);
 
  const containerRef = useRef(null);
  const scrollWrapRef = useRef(null); // FIX [6]: the horizontally-scrollable canvas wrapper
  const { settings, tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);
 
  // Tab accent — falls back to theme accent if not provided by parent
  const playColor = tabColor ?? T.accent;
 
  // ── Derived values ──────────────────────────────────────────────────────
  const selectedWindow   = TIME_WINDOWS[windowIdx];
  const speedMult        = SPEED_OPTIONS[speedIdx].mult;
  const zoomMult          = ZOOM_OPTIONS[zoomIdx].mult;            // FIX [6]
  const gainOverride     = GAIN_OPTIONS[gainIdx].mmPerMv;
  const displayWindowSec = selectedWindow.windowSec;

  // fetchZoom: purely a translation into useEcgData's API — tells the hook
  // how many seconds of real data to buffer/slice. Unrelated to rendering.
  const fetchZoom        = BASE_WINDOW_SEC / displayWindowSec;

  // canvasZoom: FIX [6] — pure rendering scale (px/sec), driven ONLY by
  // Speed × Zoom. Deliberately has nothing to do with displayWindowSec
  // anymore, so switching VIEW windows never compresses the waveform —
  // ECGCanvas instead grows its own width and the canvas area scrolls.
  const canvasZoom        = speedMult * zoomMult;
 
  // ── Data ────────────────────────────────────────────────────────────────
  const {
    leadsMap, leadNames, loading, error, totalSec, sr: ecgSr,
  } = useEcgData(patient?.id, timeOffset, fetchZoom);
 
  // ── Signal metrics ───────────────────────────────────────────────────────
  const metrics = useSignalMetrics(leadsMap, ecgSr ?? 250);
  const hr      = (metrics.hr && !manualHr) ? metrics.hr : (manualHr ?? 72);
 
  // ── Notify App.jsx with live state ───────────────────────────────────────
  useEffect(() => {
    onStateChange?.({
      hr,
      timeOffset,
      leadCount: leadNames.length,
      totalSec,
    });
  }, [hr, timeOffset, leadNames.length, totalSec, onStateChange]);
 
  // ── Fullscreen ───────────────────────────────────────────────────────────
  const toggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }, []);
 
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);
 
  // ── Generate PDF report ──────────────────────────────────────────────────
  const generateReport = useCallback(async () => {
    if (!patient?.id) return;
    setReportLoading(true);
    notify?.({ type: "info", title: "Generating report…",
      message: "Building clinical PDF — this may take a few seconds." });
    try {
      const res = await fetch(`/api/reports/${patient.id}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: {},
          metrics: {
            hr,
            rr:    metrics.rr,
            pr:    metrics.pr,
            qrs:   metrics.qrs,
            qt:    metrics.qt,
            qtc:   metrics.qtc,
            sdnn:  metrics.sdnn,
            rmssd: metrics.rmssd,
          },
          notes: "",
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      const blob     = await res.blob();
      const url      = URL.createObjectURL(blob);
      const link     = document.createElement("a");
      link.href      = url;
      link.download  = `Holter_ECG_${patient.id}_${
        new Date().toISOString().slice(0, 10)}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      notify?.({ type: "success", title: "Report downloaded",
        message: link.download });
    } catch (e) {
      notify?.({ type: "error", title: "Report failed", message: e.message });
    } finally {
      setReportLoading(false);
    }
  }, [patient, hr, metrics, notify]);
 
  // ── Caliper ──────────────────────────────────────────────────────────────
  const onCaliperMeasurement = useCallback((measurement) => {
    setCaliperMeasurements(prev => [...prev.slice(-4), measurement]);
  }, []);
 
  const clearCalipers = useCallback(() => {
    setCaliperMeasurements([]);
  }, []);
 
  // ── RAF playback loop ────────────────────────────────────────────────────
  const playStartWallRef = useRef(null);
  const playStartEcgRef  = useRef(0);
  const rafRef           = useRef(null);
 
  const stopPlay = useCallback(() => {
    setPlaying(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    playStartWallRef.current = null;
  }, []);
 
  const resyncPlayback = useCallback(() => {
    if (playStartWallRef.current !== null) {
      playStartWallRef.current = performance.now();
      playStartEcgRef.current  = timeOffset;
    }
  }, [timeOffset]);
 
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
      const stopAt     = Math.max(0, totalSec - displayWindowSec);
      if (nextOffset >= stopAt) {
        stopPlay();
        setTimeOffset(stopAt);
        return;
      }
      setTimeOffset(nextOffset);
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, totalSec, displayWindowSec]);

  // ── FIX [6]: keep the view pinned to the live edge when PLAY starts ─────
  // The canvas slice always starts exactly at the current timeOffset (the
  // playhead), so the live edge is always x=0 on the canvas. If the doctor
  // had manually scrolled right to inspect something while paused, resume
  // playback should bring them back to "now" rather than continuing to
  // play out of view.
  useEffect(() => {
    if (playing) {
      scrollWrapRef.current?.scrollTo({ left: 0, behavior: "auto" });
    }
  }, [playing]);
 
  // ── Empty state ──────────────────────────────────────────────────────────
  if (!patient) {
    return (
      <div style={{
        flex:           1,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        background:     T.surface0,
      }}>
        <div style={{ textAlign: "center" }}>
          <i className="ti ti-device-heart-monitor"
            style={{ fontSize: 32, color: T.border1, display: "block",
              marginBottom: 12 }} aria-hidden="true" />
          <span style={{ ...MONO, fontSize: 11, color: T.grey7 }}>
            No patient selected
          </span>
        </div>
      </div>
    );
  }
 
  const leadDesc = leadNames.length === 0
    ? "Detecting leads…"
    : `${leadNames.length}-lead  ·  ${leadNames.join(" · ")}`;
 
  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      style={{
        display:       "flex",
        flexDirection: "column",
        flex:           1,
        overflow:      "hidden",
        minHeight:     0,
        background:    isFullscreen ? T.surface0 : undefined,
      }}
    >
      {/* Patient metrics banner */}
      <PatientBanner
        patient={patient}
        hr={hr}
        leadCount={leadNames.length}
        metrics={metrics}
        fromSignal={!!metrics.hr && !manualHr}
      />
 
      {/* ── Toolbar row 1 — view / speed / zoom / gain + play status ───── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        padding:      "0 10px",
        height:       34,
        background:   T.surface1,
        borderBottom: `0.5px solid ${T.border1}`,
        flexShrink:    0,
        gap:           3,
        minWidth:     0,
      }}>
 
        {/* Lead badge — compact, fixed width */}
        <div style={{
          display:      "flex",
          alignItems:   "center",
          gap:          5,
          background:   T.withAlpha(T.accent, 0.07),
          border:       `0.5px solid ${T.withAlpha(T.accent, 0.20)}`,
          borderRadius: 4,
          padding:      "0 8px",
          height:       22,
          flexShrink:   0,
          maxWidth:     160,
          overflow:     "hidden",
        }}>
          <i className="ti ti-activity"
            style={{ fontSize: 13, color: T.accent, flexShrink: 0 }}
            aria-hidden="true" />
          <span style={{
            ...MONO, fontSize: 9, color: T.accent,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {leadDesc}
          </span>
        </div>
 
        {/* VIEW — FIX [6]: now means "how much to buffer for scroll", not compression */}
        <ToolGroup label="View" T={T}>
          {TIME_WINDOWS.map((w, i) => (
            <ToolBtn
              key={w.label}
              T={T}
              active={i === windowIdx}
              onClick={() => { setWindowIdx(i); resyncPlayback(); }}
              title={
                w.windowSec > 120
                  ? `Load ${w.label} of recording (overview scale beyond a safe canvas width)`
                  : `Load ${w.label} of recording at true scale — scroll to see all of it`
              }
            >
              {w.label}
            </ToolBtn>
          ))}
        </ToolGroup>
 
        {/* SPEED — clinical paper speed */}
        <ToolGroup label="Speed" T={T}>
          {SPEED_OPTIONS.map((s, i) => (
            <ToolBtn
              key={s.label}
              T={T}
              active={i === speedIdx}
              onClick={() => { setSpeedIdx(i); resyncPlayback(); }}
              title={`Paper speed: ${s.label}`}
            >
              {s.label}
            </ToolBtn>
          ))}
        </ToolGroup>

        {/* ZOOM — FIX [6]: new, genuine zoom, independent of Speed and View */}
        <ToolGroup label="Zoom" T={T}>
          {ZOOM_OPTIONS.map((z, i) => (
            <ToolBtn
              key={z.label}
              T={T}
              active={i === zoomIdx}
              onClick={() => { setZoomIdx(i); resyncPlayback(); }}
              title={`Zoom: ${z.label} of true waveform scale`}
            >
              {z.label}
            </ToolBtn>
          ))}
        </ToolGroup>
 
        {/* GAIN */}
        <ToolGroup label="Gain" T={T}>
          {GAIN_OPTIONS.map((g, i) => (
            <ToolBtn
              key={g.label}
              T={T}
              active={i === gainIdx}
              onClick={() => setGainIdx(i)}
              title={g.mmPerMv ? `Gain: ${g.label}` : "Auto-gain per lead"}
            >
              {g.label}
            </ToolBtn>
          ))}
        </ToolGroup>
 
        {/* Spacer */}
        <div style={{ flex: 1, minWidth: 0 }} />
 
        {/* Error badge */}
        {error && (
          <span style={{
            ...MONO,
            fontSize:     9,
            color:        T.red,
            background:   T.withAlpha(T.red, 0.08),
            border:       `0.5px solid ${T.withAlpha(T.red, 0.22)}`,
            padding:      "0 8px",
            height:       22,
            display:      "flex",
            alignItems:   "center",
            gap:          4,
            borderRadius: 4,
            maxWidth:     180,
            overflow:     "hidden",
            textOverflow: "ellipsis",
            whiteSpace:   "nowrap",
            flexShrink:   0,
          }}>
            <i className="ti ti-alert-triangle"
              style={{ fontSize: 12, flexShrink: 0 }} aria-hidden="true" />
            {error.split("\n")[0]}
          </span>
        )}
 
        {/* Play status dot + label */}
        <div style={{
          display:    "flex",
          alignItems: "center",
          gap:        6,
          paddingLeft: 8,
          borderLeft: `0.5px solid ${T.border1}`,
          flexShrink: 0,
        }}>
          <span style={{
            display:      "inline-block",
            width:         6,
            height:        6,
            borderRadius: "50%",
            background:    playing ? playColor : T.grey7,
            animation:     playing ? "ecgPulse 1.1s ease-in-out infinite" : "none",
            flexShrink:   0,
          }} />
          <span style={{ ...MONO, fontSize: 10, color: playing ? playColor : T.grey6 }}>
            {playing ? "Playing" : "Paused"}
          </span>
        </div>
      </div>
 
      {/* ── Toolbar row 2 — beat legend (left, shrinkable) + tools (right, fixed) ── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        paddingLeft:  10,
        paddingRight: 14,   // extra right clearance so fullscreen btn never clips
        height:       28,
        background:   T.surface2,
        borderBottom: `0.5px solid ${T.border1}`,
        flexShrink:    0,
        minWidth:     0,
        gap:          6,
      }}>
 
        {/* Beat legend — allowed to shrink so tools always have room */}
        <div style={{
          display:    "flex",
          alignItems: "center",
          gap:        8,
          flex:       "1 1 0",
          minWidth:   0,
          overflow:   "hidden",
        }}>
          <span style={{
            ...MONO,
            fontSize:      9,
            color:         T.grey6,
            letterSpacing: "0.07em",
            textTransform: "uppercase",
            flexShrink:    0,
          }}>
            Beat types
          </span>
          {[
            { key: "N",   color: T.green,  label: "Normal (N)"      },
            { key: "V",   color: T.red,    label: "Ventricular (V)" },
            { key: "A",   color: T.purple, label: "Atrial (A)"      },
            { key: "Art", color: T.amber,  label: "Artefact (Art)"  },
            { key: "?",   color: T.grey1,  label: "Unknown (?)"     },
          ].map(({ key, color, label }) => (
            <div
              key={key}
              title={label}
              style={{
                display:    "flex",
                alignItems: "center",
                gap:        4,
                cursor:     "help",
                flexShrink: 0,
              }}
            >
              <div style={{
                width:        7,
                height:       7,
                borderRadius: 1,
                background:   T.withAlpha(color, 0.16),
                border:       `0.5px solid ${color}`,
                flexShrink:   0,
              }} />
              <span style={{ ...MONO, fontSize: 9, color: T.grey7 }}>
                {label}
              </span>
            </div>
          ))}
        </div>
 
        {/* ── Right: all tool buttons — never shrink ────────────────── */}
        <div style={{
          display:    "flex",
          alignItems: "center",
          gap:        3,
          flexShrink: 0,
        }}>
 
          {/* HR source badge + override */}
          {metrics.hr && (
            <>
              <span style={{
                ...MONO,
                fontSize:     9,
                background:   T.withAlpha(T.green, 0.08),
                border:       `0.5px solid ${T.withAlpha(T.green, 0.22)}`,
                color:        T.green,
                padding:      "0 7px",
                height:       20,
                display:      "flex",
                alignItems:   "center",
                gap:          4,
                borderRadius: 3,
                flexShrink:   0,
              }}>
                <i className="ti ti-heart-rate-monitor"
                  style={{ fontSize: 13 }} aria-hidden="true" />
                HR from signal
              </span>
              <button
                onClick={() => setManualHr(manualHr ? null : hr)}
                style={{
                  ...MONO,
                  fontSize:     9,
                  height:       20,
                  padding:      "0 7px",
                  background:   "transparent",
                  border:       `0.5px solid ${T.border1}`,
                  color:        T.grey1,
                  borderRadius: 3,
                  cursor:       "pointer",
                  display:      "flex",
                  alignItems:   "center",
                  gap:          4,
                  flexShrink:   0,
                }}
              >
                <i className={`ti ${manualHr ? "ti-antenna" : "ti-edit"}`}
                  style={{ fontSize: 12 }} aria-hidden="true" />
                {manualHr ? "Use signal" : "Override"}
              </button>
              <ToolDivider T={T} />
            </>
          )}
 
          {/* Caliper readout pills */}
          {caliperMeasurements.length > 0 && (
            <>
              <i className="ti ti-ruler"
                style={{ fontSize: 13, color: T.amber, flexShrink: 0 }}
                aria-hidden="true" />
              {caliperMeasurements.map((m, i) => (
                <span key={i} style={{
                  ...MONO,
                  fontSize:     10,
                  background:   T.withAlpha(T.amber, 0.08),
                  border:       `0.5px solid ${T.withAlpha(T.amber, 0.25)}`,
                  color:        T.amber,
                  padding:      "0 7px",
                  height:       20,
                  display:      "flex",
                  alignItems:   "center",
                  gap:          4,
                  borderRadius: 3,
                  flexShrink:   0,
                }}>
                  {m.ms} ms
                  {m.bpm && (
                    <span style={{ ...MONO, fontSize: 9, color: T.grey1 }}>
                      · {m.bpm} bpm
                    </span>
                  )}
                </span>
              ))}
              <ToolDivider T={T} />
            </>
          )}
 
          {/* MARKERS */}
          <ToolBtn
            T={T}
            active={showMarkers}
            icon={showMarkers ? "ti-eye" : "ti-eye-off"}
            onClick={() => setShowMarkers(v => !v)}
            title="Toggle R-peak, RR interval, PR and QRS markers"
          >
            Markers
          </ToolBtn>
 
          <ToolDivider T={T} />
 
          {/* CALIPER */}
          <ToolBtn
            T={T}
            active={caliperArmed}
            danger={caliperArmed}
            icon={caliperArmed ? "ti-ruler-off" : "ti-ruler"}
            onClick={() => { setCaliperArmed(v => !v); clearCalipers(); }}
            title={caliperArmed
              ? "Disarm caliper"
              : "Arm caliper — drag on ECG to measure interval"}
          >
            {caliperArmed ? "Armed" : "Caliper"}
          </ToolBtn>
 
          {caliperMeasurements.length > 0 && (
            <ToolBtn
              T={T}
              icon="ti-x"
              iconOnly
              onClick={clearCalipers}
              title="Clear caliper measurements"
            />
          )}
 
          <ToolDivider T={T} />
 
          {/* DIARY */}
          <ToolBtn
            T={T}
            active={diaryOpen}
            icon="ti-notebook"
            onClick={() => setDiaryOpen(v => !v)}
            title="Patient diary and annotations"
          >
            Diary
          </ToolBtn>
 
          {/* REPORT */}
          <ToolBtn
            T={T}
            icon={reportLoading ? "ti-loader-2" : "ti-file-description"}
            disabled={reportLoading}
            onClick={generateReport}
            title="Generate clinical PDF report"
          >
            {reportLoading ? "Generating…" : "Report"}
          </ToolBtn>
 
          <ToolDivider T={T} />
 
          {/* FULLSCREEN — text label included so button is always visible
              even before @tabler/icons-webfont finishes loading           */}
          <ToolBtn
            T={T}
            active={isFullscreen}
            icon={isFullscreen ? "ti-arrows-minimize" : "ti-arrows-maximize"}
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          >
            {isFullscreen ? "Exit" : "Full"}
          </ToolBtn>
 
        </div>
      </div>
 
      {/* ── ECG canvas area + DiaryPanel overlay ──────────────────────── */}
      <div style={{
        flex:      1,
        overflow:  "hidden",
        position:  "relative",
        display:   "flex",
        minHeight: 0,
      }}>
 
        {/* Scrollable canvas — FIX [6]: this is now a REAL horizontal scroll
            area when the canvas renders wider than the viewport at true
            scale. ref'd so we can pin scrollLeft to 0 ("now") on play. */}
        <div
          ref={scrollWrapRef}
          style={{
            flex:       1,
            overflow:   "auto",
            position:   "relative",
            background: T.surface0,
            padding:    "8px 8px 0",
            cursor:     caliperArmed ? "crosshair" : "default",
          }}
        >
          <LoadingOverlay visible={loading && !leadsMap} />
          <ECGCanvas
            leadsMap={leadsMap}
            leadNames={leadNames}
            sr={ecgSr ?? 250}
            zoom={canvasZoom}
            traceThickness={settings?.traceThickness ?? 1.5}
            showMarkers={showMarkers}
            precomputedPeaks={metrics.peaks}
            signalMetrics={metrics}
            beatLabels={beatLabels}
            beatColors={BEAT_COLORS}
            timeOffset={timeOffset}
            error={error}
            gainOverride={gainOverride}
            caliperArmed={caliperArmed}
            caliperMeasurements={caliperMeasurements}
            onCaliperMeasurement={onCaliperMeasurement}
          />
        </div>
 
        {/* DiaryPanel — slides in from right over canvas */}
        <DiaryPanel
          patientId={patient?.id}
          open={diaryOpen}
          onClose={() => setDiaryOpen(false)}
          timeOffset={timeOffset}
          onSeek={t => { setTimeOffset(t); resyncPlayback(); }}
          onMarkersChange={setDiaryMarkers}
          notify={notify}
        />
      </div>
 
      {/* Timeline / playback bar */}
      <TimelineBar
        timeOffset={timeOffset}
        setTimeOffset={t => { setTimeOffset(t); resyncPlayback(); }}
        totalDuration={totalSec}
        hr={hr}
        setHr={v => setManualHr(v)}
        showManualHr={!metrics.hr || !!manualHr}
        playing={playing}
        setPlaying={setPlaying}
        windowSec={displayWindowSec}
        eventMarkers={diaryMarkers}
      />
 
      <style>{`
        @keyframes ecgPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.3; transform:scale(0.75); }
        }
      `}</style>
    </div>
  );
}

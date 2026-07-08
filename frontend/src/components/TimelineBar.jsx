/**
 * TimelineBar.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Theme-aware: all colors derived from getEcgTheme(tokens, theme).
 *
 * Preserved:
 *  ✓ Playback controls: jump-to-start, ← 1m, ← 10s, PLAY/PAUSE, 10s →, 1m →, jump-to-end
 *  ✓ HH:MM:SS position display
 *  ✓ Scrubber range input with viewport slice overlay
 *  ✓ Event marker strip (Phase 2 ready)
 *  ✓ Window size indicator badge
 *  ✓ HR display — manual slider OR read-only signal badge
 *  ✓ Marker count summary
 */

import React, { useRef, useCallback } from "react";
import { useApp }      from "../context/AppContext";
import { getEcgTheme } from "../styles/themeTokens";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

const MARKER_LABELS = {
  arrhythmia: "ARR",
  st:         "ST",
  qt:         "QT",
  pause:      "PSE",
  custom:     "EVT",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmtHMS(s) {
  const h   = Math.floor(s / 3600).toString().padStart(2, "0");
  const m   = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

function Btn({ children, onClick, active, disabled, title, small, T }) {
  return (
    <button onClick={onClick} title={title} disabled={disabled} style={{
      ...MONO,
      fontSize:   small ? 9 : 11,
      padding:    small ? "3px 6px" : "4px 8px",
      cursor:     disabled ? "default" : "pointer",
      background: active ? T.withAlpha(T.accent, 0.12) : "transparent",
      color:      disabled ? T.grey9 : active ? T.accent : T.grey5,
      border:     active ? `1px solid ${T.withAlpha(T.accent, 0.3)}` : `1px solid ${T.border1}`,
      borderRadius: 4,
      transition: "all 0.1s",
      letterSpacing: "0.04em",
      opacity:    disabled ? 0.35 : 1,
      flexShrink: 0,
    }}>{children}</button>
  );
}

function Sep({ T }) {
  return <div style={{ width: 1, height: 20, background: T.grey10, flexShrink: 0 }} />;
}

// ── Event marker strip component ──────────────────────────────────────────────
// Renders directly above the scrubber row.
function EventMarkerStrip({ eventMarkers, totalDuration, timeOffset, windowSec, onJump, T }) {
  const hasMarkers = eventMarkers && eventMarkers.length > 0;

  return (
    <div style={{
      position: "relative",
      width: "100%",
      height: hasMarkers ? 20 : 10,
      background: T.surface0,
      borderBottom: `1px solid ${T.border0}`,
      overflow: "hidden",
      flexShrink: 0,
    }}>
      {/* Baseline rule */}
      <div style={{
        position: "absolute",
        bottom: 0, left: 0, right: 0,
        height: 1,
        background: T.grey10,
      }} />

      {/* Viewport window indicator — shown on the strip as well */}
      {totalDuration > 0 && (
        <div style={{
          position: "absolute",
          bottom: 0,
          left: `${(timeOffset / totalDuration) * 100}%`,
          width: `${Math.min(100, (windowSec / totalDuration) * 100)}%`,
          height: "100%",
          background: T.withAlpha(T.accent, 0.06),
          borderLeft:  `1px solid ${T.withAlpha(T.accent, 0.25)}`,
          borderRight: `1px solid ${T.withAlpha(T.accent, 0.25)}`,
          pointerEvents: "none",
        }} />
      )}

      {/* Phase 2 event markers — rendered as coloured ticks */}
      {hasMarkers && eventMarkers.map((marker, i) => {
        if (!totalDuration || marker.timeSec === undefined) return null;
        const pct  = (marker.timeSec / totalDuration) * 100;
        const color= T.markerColors[marker.type] ?? T.markerColors.custom;
        const lbl  = MARKER_LABELS[marker.type]  ?? "EVT";
        return (
          <div
            key={i}
            title={marker.label ?? `${lbl} at ${fmtHMS(marker.timeSec)}`}
            onClick={() => onJump?.(Math.max(0, marker.timeSec - windowSec / 2))}
            style={{
              position:  "absolute",
              bottom:    0,
              left:      `${pct}%`,
              transform: "translateX(-50%)",
              width:     8,
              height:    "100%",
              cursor:    "pointer",
              display:   "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: 1,
            }}
          >
            {/* Tick line */}
            <div style={{
              width: 1.5,
              flex: 1,
              background: color,
              opacity: 0.8,
            }} />
            {/* Diamond head */}
            <div style={{
              width: 5, height: 5,
              background: color,
              transform: "rotate(45deg)",
              marginBottom: 1,
              flexShrink: 0,
            }} />
          </div>
        );
      })}

      {/* "Phase 2" hint when no markers — subtle, won't confuse client */}
      {!hasMarkers && (
        <span style={{
          ...MONO, fontSize: 7, color: T.grey11,
          position: "absolute", right: 6, top: "50%",
          transform: "translateY(-50%)",
          pointerEvents: "none",
          letterSpacing: "0.04em",
        }}>
          ARRHYTHMIA EVENTS · PHASE 2
        </span>
      )}
    </div>
  );
}

// ── Viewport slice overlay on scrubber ────────────────────────────────────────
function ViewportSlice({ timeOffset, totalDuration, windowSec, T }) {
  if (!totalDuration) return null;

  const leftPct  = (timeOffset / totalDuration) * 100;
  const widthPct = Math.min(100 - leftPct, (windowSec / totalDuration) * 100);

  return (
    <div
      aria-hidden="true"
      style={{
        position:      "absolute",
        top:           "50%",
        transform:     "translateY(-50%)",
        left:          `${leftPct}%`,
        width:         `${Math.max(0.3, widthPct)}%`,
        height:        6,
        background:    T.withAlpha(T.accent, 0.35),
        border:        `1px solid ${T.withAlpha(T.accent, 0.6)}`,
        borderRadius:  2,
        pointerEvents: "none",
        zIndex:        2,
        transition:    "left 0.05s linear, width 0.05s linear",
      }}
    />
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function TimelineBar({
  timeOffset,
  setTimeOffset,
  totalDuration,
  hr,
  setHr,
  showManualHr,
  playing,
  setPlaying,
  windowSec = 10,
  // Phase 2 populates this
  eventMarkers = [],
}) {
  const { tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);
  const trackRef = useRef(null);

  const clamp = useCallback((t) =>
    Math.max(0, Math.min(totalDuration ? totalDuration - windowSec : 0, t)),
    [totalDuration, windowSec]
  );

  const step = useCallback((d) => setTimeOffset(clamp(timeOffset + d)),
    [timeOffset, clamp, setTimeOffset]
  );

  const jumpTo = useCallback((t) => setTimeOffset(clamp(t)),
    [clamp, setTimeOffset]
  );

  return (
    <div style={{
      background: T.surface0,
      borderTop:  `1px solid ${T.border0}`,
      flexShrink: 0,
    }}>

      {/* ── Event marker strip ──────────────────────────────────────────── */}
      <EventMarkerStrip
        T={T}
        eventMarkers={eventMarkers}
        totalDuration={totalDuration}
        timeOffset={timeOffset}
        windowSec={windowSec}
        onJump={jumpTo}
      />

      {/* ── Main controls row ────────────────────────────────────────────── */}
      <div style={{
        padding:     "7px 14px",
        display:     "flex",
        alignItems:  "center",
        gap:         8,
        flexWrap:    "wrap",
      }}>

        {/* Playback controls */}
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          {/* Jump to start */}
          <Btn T={T} small onClick={() => jumpTo(0)} title="Jump to start" disabled={timeOffset <= 0}>
            ⏮
          </Btn>
          <Btn T={T} onClick={() => step(-60)} title="Back 1 min" disabled={timeOffset <= 0}>
            ← 1m
          </Btn>
          <Btn T={T} onClick={() => step(-10)} title="Back 10s"  disabled={timeOffset <= 0}>
            ← 10s
          </Btn>
          <Btn
            T={T}
            onClick={() => setPlaying(p => !p)}
            active={playing}
            title="Play / pause"
          >
            {playing ? "⏸ PAUSE" : "▶ PLAY"}
          </Btn>
          <Btn T={T} onClick={() => step(10)}  title="Forward 10s"
            disabled={!totalDuration || timeOffset >= totalDuration - windowSec}>
            10s →
          </Btn>
          <Btn T={T} onClick={() => step(60)}  title="Forward 1 min"
            disabled={!totalDuration || timeOffset >= totalDuration - windowSec}>
            1m →
          </Btn>
          {/* Jump to end */}
          <Btn T={T} small onClick={() => jumpTo(totalDuration - windowSec)} title="Jump to end"
            disabled={!totalDuration || timeOffset >= totalDuration - windowSec}>
            ⏭
          </Btn>
        </div>

        <Sep T={T} />

        {/* Time position */}
        <span style={{ ...MONO, fontSize: 12, color: T.grey5, minWidth: 68, flexShrink: 0 }}>
          {fmtHMS(timeOffset)}
        </span>

        {/* ── Scrubber + viewport slice overlay ──────────────────────────── */}
        <div style={{ flex: 1, minWidth: 80, position: "relative", display: "flex", alignItems: "center" }}>
          <input
            ref={trackRef}
            type="range"
            min={0}
            max={totalDuration || 0}
            step={0.5}
            value={timeOffset}
            onChange={e => setTimeOffset(+e.target.value)}
            style={{ width: "100%", accentColor: T.accent }}
          />
          {/* Viewport slice overlay — % positioned, no px math */}
          <ViewportSlice
            T={T}
            timeOffset={timeOffset}
            totalDuration={totalDuration}
            windowSec={windowSec}
          />
        </div>

        {/* Total duration */}
        <span style={{ ...MONO, fontSize: 11, color: T.grey7, minWidth: 68, flexShrink: 0 }}>
          {fmtHMS(totalDuration || 0)}
        </span>

        {/* Window size badge */}
        <span style={{
          ...MONO, fontSize: 9,
          border: `1px solid ${T.border1}`, color: T.grey7,
          padding: "2px 6px", borderRadius: 3, flexShrink: 0,
        }}>
          {windowSec < 60
            ? `${windowSec.toFixed(1)}s view`
            : `${(windowSec / 60).toFixed(1)}m view`
          }
        </span>

        <Sep T={T} />

        {/* HR display */}
        {showManualHr ? (
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ ...MONO, fontSize: 11, color: T.grey5 }}>HR</span>
            <input
              type="range" min={30} max={200} step={1} value={hr}
              onChange={e => setHr(+e.target.value)}
              style={{ width: 90, accentColor: T.red }}
            />
            <span style={{ ...MONO, fontSize: 13, color: T.red, minWidth: 26 }}>{hr}</span>
            <span style={{ ...MONO, fontSize: 10, color: T.grey7 }}>bpm</span>
          </div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ ...MONO, fontSize: 9, color: T.grey7 }}>HR</span>
            <span style={{ ...MONO, fontSize: 14, color: T.red }}>{hr}</span>
            <span style={{ ...MONO, fontSize: 9,  color: T.grey7 }}>bpm</span>
            <span style={{
              ...MONO, fontSize: 8,
              background: T.withAlpha(T.green, 0.08),
              border:     `1px solid ${T.withAlpha(T.green, 0.2)}`,
              color:      T.green,
              padding:    "1px 5px", borderRadius: 2,
            }}>signal</span>
          </div>
        )}

        {/* Marker count badge — shows how many events are on the strip */}
        {eventMarkers && eventMarkers.length > 0 && (
          <>
            <Sep T={T} />
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              {Object.entries(
                eventMarkers.reduce((acc, m) => {
                  acc[m.type] = (acc[m.type] || 0) + 1;
                  return acc;
                }, {})
              ).map(([type, count]) => {
                const color = T.markerColors[type] ?? T.grey1;
                return (
                  <span key={type} style={{
                    ...MONO, fontSize: 8,
                    background: T.withAlpha(color, 0.1),
                    border:     `1px solid ${T.withAlpha(color, 0.38)}`,
                    color,
                    padding:    "1px 5px", borderRadius: 2,
                  }}>
                    {MARKER_LABELS[type] ?? type} ×{count}
                  </span>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
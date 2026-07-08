/**
 * Sidebar.jsx
 * Left panel: patient list from API, recording metadata, live interval bars.
 * Theme-aware: all colors derived from getEcgTheme(tokens, theme).
 */

import React from "react";
import { computeIntervals } from "../utils/ecgIntervals";
import { useApp }       from "../context/AppContext";
import { getEcgTheme }  from "../styles/themeTokens";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

// ── Tiny sub-components ───────────────────────────────────────────────────────

function SectionLabel({ text, T }) {
  return (
    <div style={{
      ...MONO, fontSize: 9, color: T.grey6,
      letterSpacing: "0.15em", textTransform: "uppercase",
      padding: "10px 14px 5px",
    }}>
      {text}
    </div>
  );
}

function StatRow({ label, value, accent, T }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between",
      alignItems: "center",
      padding: "4px 14px",
      borderBottom: `1px solid ${T.border0}`,
    }}>
      <span style={{ fontSize: 11, color: T.grey4 }}>{label}</span>
      <span style={{ ...MONO, fontSize: 11, color: accent || T.grey2 }}>{value}</span>
    </div>
  );
}

function MiniBar({ value, max, color, T }) {
  const pct = Math.min(100, (value / max) * 100).toFixed(1);
  return (
    <div style={{
      height: 3, background: T.grey10, borderRadius: 2, overflow: "hidden",
    }}>
      <div style={{
        width: `${pct}%`, height: "100%",
        background: color, borderRadius: 2,
        transition: "width 0.4s ease",
      }} />
    </div>
  );
}

function IntervalRow({ label, value, unit, barValue, barMax, color, T }) {
  return (
    <div style={{ padding: "5px 14px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
        <span style={{ fontSize: 11, color: T.grey5 }}>{label}</span>
        <span style={{ ...MONO, fontSize: 11, color }}>
          {value}<span style={{ color: T.grey7, marginLeft: 2 }}>{unit}</span>
        </span>
      </div>
      <MiniBar T={T} value={barValue} max={barMax} color={color} />
    </div>
  );
}

function Divider({ T }) {
  return <div style={{ height: 1, background: T.border0, margin: "6px 0" }} />;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Sidebar({
  patients,          // array from API
  activePatient,
  onSelectPatient,
  hr,
  timeOffset,
  totalDuration,
  loading,
  apiError,
}) {
  const { tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);
  const iv = computeIntervals(hr);

  const fmtTime = (s) => {
    const h = Math.floor(s / 3600).toString().padStart(2, "0");
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
    return `${h}h ${m}m`;
  };

  return (
    <div style={{
      width: 200,
      flexShrink: 0,
      height: "100%",
      background: T.surface0,
      borderRight: `1px solid ${T.border1}`,
      display: "flex",
      flexDirection: "column",
      overflowY: "auto",
    }}>

      {/* ── Logo ─────────────────────────────────────────────────────────── */}
      <div style={{
        padding: "14px 14px 12px",
        borderBottom: `1px solid ${T.border0}`,
      }}>
        <div style={{ ...MONO, fontSize: 13, color: T.accentSoft, letterSpacing: "0.1em" }}>
          HOLTER ECG
        </div>
        <div style={{ fontSize: 10, color: T.grey7, marginTop: 2 }}>
          48-hour Monitor System
        </div>
      </div>

      {/* ── Patients ─────────────────────────────────────────────────────── */}
      <SectionLabel T={T} text="Patients" />

      {apiError && (
        <div style={{
          margin: "0 10px 6px",
          padding: "6px 8px",
          background: T.withAlpha(T.red, 0.06),
          border: `1px dashed ${T.withAlpha(T.red, 0.2)}`,
          borderRadius: 4,
          fontSize: 10,
          color: T.red,
          ...MONO,
        }}>
          API unavailable
        </div>
      )}

      {loading && (
        <div style={{ fontSize: 10, color: T.grey6, padding: "4px 14px", ...MONO }}>
          Loading…
        </div>
      )}

      <div style={{ padding: "0 8px" }}>
        {patients.map((p) => {
          const active = activePatient?.id === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onSelectPatient(p)}
              style={{
                width: "100%", textAlign: "left",
                padding: "8px 8px",
                marginBottom: 2,
                background: active ? T.withAlpha(T.accentSoft, 0.07) : "transparent",
                border: active ? `1px solid ${T.withAlpha(T.accentSoft, 0.2)}` : "1px solid transparent",
                borderRadius: 5,
                cursor: "pointer",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 12, color: active ? T.textPrimary : T.grey3, fontWeight: 500 }}>
                  {p.name}
                </span>
                <span style={{ ...MONO, fontSize: 9, color: T.grey7 }}>{p.id}</span>
              </div>
              <div style={{
                ...MONO, fontSize: 10, marginTop: 2,
                color: active ? T.accentSoft : T.grey8,
              }}>
                Age {p.age} · Sinus
              </div>
            </button>
          );
        })}
      </div>

      <Divider T={T} />

      {/* ── Recording stats ──────────────────────────────────────────────── */}
      <SectionLabel T={T} text="Recording" />
      <StatRow T={T} label="Duration"    value="48:00 hr" />
      <StatRow T={T} label="Elapsed"     value={fmtTime(timeOffset)} accent={T.grey3} />
      <StatRow T={T} label="Sample rate" value="250 Hz" />
      <StatRow T={T} label="Leads"       value="3 / 12" />
      <StatRow T={T} label="Resolution"  value="16-bit" />
      <StatRow T={T} label="Progress"
        value={`${((timeOffset / totalDuration) * 100).toFixed(1)}%`}
        accent={T.accentSoft}
      />

      <Divider T={T} />

      {/* ── Interval bars ────────────────────────────────────────────────── */}
      <SectionLabel T={T} text="Intervals" />

      <IntervalRow
        T={T}
        label="Heart Rate"
        value={hr}       unit="bpm"
        barValue={hr}    barMax={200}
        color={T.red}
      />
      <IntervalRow
        T={T}
        label="PR"
        value={(iv.pr  * 1000).toFixed(0)} unit="ms"
        barValue={iv.pr  * 1000}           barMax={300}
        color={T.cyan}
      />
      <IntervalRow
        T={T}
        label="QRS"
        value={(iv.qrs * 1000).toFixed(0)} unit="ms"
        barValue={iv.qrs * 1000}           barMax={150}
        color={T.accentSoft}
      />
      <IntervalRow
        T={T}
        label="QT"
        value={(iv.qt  * 1000).toFixed(0)} unit="ms"
        barValue={iv.qt  * 1000}           barMax={500}
        color={T.purple}
      />
      <IntervalRow
        T={T}
        label="QTc"
        value={(iv.qtc * 1000).toFixed(0)} unit="ms"
        barValue={iv.qtc * 1000}           barMax={500}
        color={iv.qtc * 1000 > 450 ? T.amber : T.purple}
      />

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <div style={{ marginTop: "auto", padding: "10px 14px", borderTop: `1px solid ${T.border0}` }}>
        <div style={{ ...MONO, fontSize: 9, color: T.grey8 }}>LCC 00000-0000</div>
        <div style={{ fontSize: 9, color: T.grey9, marginTop: 2 }}>v1.0 · 2026</div>
      </div>
    </div>
  );
}
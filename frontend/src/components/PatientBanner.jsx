/**
 * PatientBanner.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Theme-aware: all colors derived from getEcgTheme(tokens, theme).
 *
 * Preserved:
 *  ✓ HR/PR/QRS/QT/QTc/RR from real signal metrics with formula fallback
 *  ✓ "live metrics" badge when measured (not estimated)
 *  ✓ SDNN / RMSSD HRV chips
 */

import React from "react";
import { computeIntervals } from "../utils/ecgIntervals";
import { useApp }       from "../context/AppContext";
import { getEcgTheme }  from "../styles/themeTokens";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

function Chip({ label, value, unit, accent, dim, T }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "5px 12px", borderRight: `1px solid ${T.border1}`,
      opacity: dim ? 0.4 : 1,
    }}>
      <span style={{
        ...MONO, fontSize: 18, fontWeight: 600,
        color: accent || T.grey2, lineHeight: 1,
      }}>
        {value ?? "—"}
      </span>
      <span style={{
        fontSize: 9, color: T.grey5, letterSpacing: "0.09em",
        textTransform: "uppercase", marginTop: 2,
      }}>{label}</span>
      {unit && <span style={{ fontSize: 9, color: T.grey7 }}>{unit}</span>}
    </div>
  );
}

function Tag({ text, color, T }) {
  return (
    <span style={{
      ...MONO, fontSize: 10, padding: "2px 7px", borderRadius: 3,
      background: T.withAlpha(color, 0.07),
      border: `1px solid ${T.withAlpha(color, 0.21)}`,
      color,
    }}>
      {text}
    </span>
  );
}

function SmallChip({ label, value, unit, color, T }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "3px 10px", borderRight: `1px solid ${T.border0}`,
    }}>
      <span style={{ ...MONO, fontSize: 13, color: color || T.grey1, lineHeight: 1 }}>
        {value ?? "—"}
      </span>
      <span style={{
        fontSize: 8, color: T.grey7, textTransform: "uppercase",
        letterSpacing: "0.08em", marginTop: 1,
      }}>{label}</span>
      {unit && <span style={{ fontSize: 8, color: T.grey8 }}>{unit}</span>}
    </div>
  );
}

export default function PatientBanner({ patient, hr, leadCount, metrics, fromSignal }) {
  const { tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);

  // Fallback: formula-based intervals when real metrics aren't ready
  const fallback = computeIntervals(hr ?? 72);

  // Prefer real measured values, fall back to formula
  const pr  = metrics?.pr  != null ? (metrics.pr  * 1000).toFixed(0)  : (fallback.pr  * 1000).toFixed(0);
  const qrs = metrics?.qrs != null ? (metrics.qrs * 1000).toFixed(0)  : (fallback.qrs * 1000).toFixed(0);
  const qt  = metrics?.qt  != null ? (metrics.qt  * 1000).toFixed(0)  : (fallback.qt  * 1000).toFixed(0);
  const qtc = metrics?.qtc != null ? (metrics.qtc * 1000).toFixed(0)  : (fallback.qtc * 1000).toFixed(0);
  const rr  = metrics?.rr  ?? fallback.rr;

  const qtcNum    = Number(qtc);
  const qtcAccent = qtcNum > 500 ? T.red : qtcNum > 450 ? T.amber : T.grey2;

  return (
    <div style={{ background: T.surface1, borderBottom: `1px solid ${T.border1}` }}>
      {/* Row 1: patient info + measured intervals */}
      <div style={{
        display: "flex", alignItems: "stretch", justifyContent: "space-between",
        padding: "9px 16px", gap: 12, flexWrap: "wrap",
      }}>

        {/* Identity */}
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 3 }}>
            <span style={{ ...MONO, fontSize: 13, color: T.textPrimary, letterSpacing: "0.04em" }}>
              {patient?.name ?? "—"}
            </span>
            <Tag text={patient?.id ?? "—"} color={T.accent} T={T} />
            {fromSignal && (
              <Tag text="live metrics" color={T.green} T={T} />
            )}
          </div>
          <div style={{ ...MONO, fontSize: 11, color: T.grey5, lineHeight: 1.6 }}>
            Age: {patient?.age ?? "—"} &nbsp;|&nbsp;
            Sex: {patient?.sex ?? "M"} &nbsp;|&nbsp;
            DOB: {patient?.dob ?? "—"}
          </div>
          <div style={{ ...MONO, fontSize: 10, color: T.grey7 }}>
            Recorded: {patient?.created_at ?? "—"} IST
          </div>
        </div>

        {/* Primary interval chips */}
        <div style={{ display: "flex", alignItems: "stretch", borderLeft: `1px solid ${T.border1}` }}>
          <Chip T={T} label="HR"  value={hr}   unit="bpm" accent={T.red} />
          <Chip T={T} label="PR"  value={pr}   unit="ms"  dim={!fromSignal} />
          <Chip T={T} label="QRS" value={qrs}  unit="ms"  dim={!fromSignal} />
          <Chip T={T} label="QT"  value={qt}   unit="ms"  dim={!fromSignal} />
          <Chip T={T} label="QTc" value={qtc}  unit="ms"  accent={qtcAccent} dim={!fromSignal} />
          <Chip T={T} label="RR"  value={rr}   unit="s"   dim={!fromSignal} />
        </div>
      </div>

      {/* Row 2: HRV + tech specs */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "4px 16px 5px", borderTop: `1px solid ${T.border0}`, flexWrap: "wrap", gap: 6,
      }}>

        {/* HRV mini strip */}
        <div style={{
          display: "flex", alignItems: "stretch", gap: 0,
          borderRight: `1px solid ${T.border1}`, paddingRight: 10, marginRight: 6,
        }}>
          <SmallChip
            T={T}
            label="SDNN"
            value={metrics?.sdnn  != null ? metrics.sdnn.toFixed(0)  : "—"}
            unit="ms" color={T.purple}
          />
          <SmallChip
            T={T}
            label="RMSSD"
            value={metrics?.rmssd != null ? metrics.rmssd.toFixed(0) : "—"}
            unit="ms" color={T.purple}
          />
        </div>

        {/* Tech spec tags */}
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", flex: 1 }}>
          {["25 mm/s", "10 mm/mV", "SR 250 Hz", "0.15–150 Hz", "50 Hz Notch",
              leadCount > 0 ? `${leadCount}-Lead` : "—"].map(t => (
            <Tag key={t} text={t} color={T.grey4} T={T} />
          ))}
        </div>

        {/* Rhythm interpretation */}
        <div style={{ display: "flex", gap: 6 }}>
          <Tag text="Sinus Rhythm" color={T.green}  T={T} />
          <Tag text="Normal ECG"   color={T.accent} T={T} />
        </div>
      </div>
    </div>
  );
}
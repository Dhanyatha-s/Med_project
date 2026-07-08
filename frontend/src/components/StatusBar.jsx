import React from "react";
import { useApp } from "../context/AppContext";
import { getEcgTheme } from "../styles/themeTokens";

const MONO = { fontFamily: "'Share Tech Mono',monospace" };

function fmtOff(s) {
  const h   = Math.floor(s / 3600).toString().padStart(2, "0");
  const m   = Math.floor((s % 3600) / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

export default function StatusBar({ patientId, timeOffset, mode, apiOk }) {
  const { tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);

  return (
    <div style={{
      background:   T.surface0,
      borderTop:    `1px solid ${T.border0}`,
      padding:      "4px 16px",
      display:      "flex",
      justifyContent: "space-between",
      alignItems:   "center",
      flexWrap:     "wrap",
      gap:          8,
      flexShrink:   0,
    }}>
      <span style={{ ...MONO, fontSize: 9, color: T.grey9 }}>
        LCC 00000-0000 &nbsp;|&nbsp; Speed: 25 mm/s &nbsp;|&nbsp; Limb: 10 mm/mV &nbsp;|&nbsp; Chest: 10 mm/mV
      </span>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{
            width: 5, height: 5, borderRadius: "50%",
            background: apiOk ? T.green : T.red,
            display: "inline-block",
          }} />
          <span style={{
            ...MONO, fontSize: 9,
            color: apiOk ? T.withAlpha(T.green, 0.7) : T.withAlpha(T.red, 0.7),
          }}>
            {apiOk ? "API OK" : "API DOWN"}
          </span>
        </div>
        <span style={{ ...MONO, fontSize: 9, color: T.grey9 }}>
          {patientId} &nbsp;|&nbsp; {mode}-Lead &nbsp;|&nbsp; T {fmtOff(timeOffset)}
        </span>
        <span style={{
          ...MONO, fontSize: 9,
          border: `1px solid ${T.grey11}`,
          color: T.grey9,
          padding: "1px 5px",
          borderRadius: 2,
        }}>
          50Ω 0.15–150 Hz
        </span>
      </div>
    </div>
  );
}
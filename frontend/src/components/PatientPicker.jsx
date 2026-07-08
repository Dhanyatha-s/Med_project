/**
 * PatientPicker.jsx
 * Modal to select a patient when adding a new tab.
 * Theme-aware: all colors derived from getEcgTheme(tokens, theme).
 */

import React from "react";
import { useApp }      from "../context/AppContext";
import { getEcgTheme } from "../styles/themeTokens";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

export default function PatientPicker({ patients, openIds, onSelect, onClose }) {
  const { tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9000,
        background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: T.surface1, border: `1px solid ${T.border2}`,
        borderRadius: 8, width: 380, overflow: "hidden",
        boxShadow: "0 20px 60px rgba(0,0,0,0.7)",
      }}>
        <div style={{
          padding: "14px 16px 10px",
          borderBottom: `1px solid ${T.border1}`,
          display: "flex", justifyContent: "space-between", alignItems: "center",
        }}>
          <span style={{ ...MONO, fontSize: 11, color: T.accent, letterSpacing: "0.1em" }}>
            SELECT PATIENT
          </span>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", color: T.grey4, cursor: "pointer", fontSize: 16 }}
          >×</button>
        </div>

        <div style={{ padding: 8 }}>
          {patients.map(p => {
            const already = openIds.includes(p.id);
            return (
              <button
                key={p.id}
                onClick={() => !already && onSelect(p)}
                style={{
                  width: "100%", textAlign: "left",
                  padding: "9px 12px",
                  background: already ? T.withAlpha(T.textPrimary, 0.02) : "transparent",
                  border: "1px solid transparent",
                  borderRadius: 5, cursor: already ? "not-allowed" : "pointer",
                  marginBottom: 3, opacity: already ? 0.4 : 1,
                  transition: "all 0.1s",
                }}
                onMouseEnter={e => { if (!already) e.currentTarget.style.background = T.withAlpha(T.accent, 0.08); }}
                onMouseLeave={e => { if (!already) e.currentTarget.style.background = "transparent"; }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 13, color: T.grey2 }}>{p.name}</span>
                  <span style={{ ...MONO, fontSize: 10, color: T.grey6 }}>{p.id}</span>
                </div>
                <div style={{ ...MONO, fontSize: 10, color: T.grey5, marginTop: 2 }}>
                  Age {p.age} · {p.sex ?? "M"}
                  {already && <span style={{ color: T.accent, marginLeft: 8 }}>already open</span>}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
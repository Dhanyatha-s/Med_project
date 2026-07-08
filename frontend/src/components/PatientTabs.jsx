/**
 * PatientTabs.jsx
 * Up to 6 patient ECG tabs — each tab is an independent viewer.
 * "+ New Patient" opens the patient picker.
 * Theme-aware: all colors derived from getEcgTheme(tokens, theme).
 */

import React from "react";
import { useApp }      from "../context/AppContext";
import { getEcgTheme } from "../styles/themeTokens";

const MAX_TABS = 6;
const MONO = { fontFamily: "'Share Tech Mono', monospace" };

export default function PatientTabs({ tabs, activeIdx, onSelect, onAdd, onClose }) {
  const { tokens, theme } = useApp();
  const T = getEcgTheme(tokens, theme);
  const tabColors = T.tabColors;

  return (
    <div style={{
      display: "flex", alignItems: "stretch",
      background: T.surface1,
      borderBottom: `1px solid ${T.border1}`,
      overflowX: "auto",
      flexShrink: 0,
      minHeight: 36,
    }}>
      {tabs.map((tab, i) => {
        const active = i === activeIdx;
        const color  = tabColors[i % tabColors.length];
        return (
          <div
            key={tab.id + i}
            onClick={() => onSelect(i)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "0 14px",
              minWidth: 130, maxWidth: 180,
              cursor: "pointer",
              background: active ? T.surface2 : "transparent",
              borderRight: `1px solid ${T.border1}`,
              borderBottom: active ? `2px solid ${color}` : "2px solid transparent",
              transition: "all 0.12s",
              position: "relative",
              flexShrink: 0,
            }}
          >
            {/* Colour dot */}
            <span style={{
              width: 6, height: 6, borderRadius: "50%",
              background: color, flexShrink: 0,
            }} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{
                ...MONO, fontSize: 11,
                color: active ? T.textPrimary : T.grey4,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                lineHeight: "1.2",
              }}>
                {tab.name}
              </div>
              <div style={{
                ...MONO, fontSize: 9,
                color: active ? color : T.grey7,
                lineHeight: "1.2",
              }}>
                {tab.id}
              </div>
            </div>
            {/* Close button — don't show if only one tab */}
            {tabs.length > 1 && (
              <button
                onClick={e => { e.stopPropagation(); onClose(i); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: T.grey6, fontSize: 13, lineHeight: 1,
                  padding: "0 2px", flexShrink: 0,
                  transition: "color 0.1s",
                }}
                onMouseEnter={e => e.target.style.color = T.grey1}
                onMouseLeave={e => e.target.style.color = T.grey6}
              >
                ×
              </button>
            )}
          </div>
        );
      })}

      {/* Add tab */}
      {tabs.length < MAX_TABS && (
        <button
          onClick={onAdd}
          style={{
            ...MONO, fontSize: 16, color: T.grey7,
            background: "none", border: "none",
            padding: "0 14px",
            cursor: "pointer", flexShrink: 0,
            transition: "color 0.12s",
          }}
          onMouseEnter={e => e.target.style.color = T.accent}
          onMouseLeave={e => e.target.style.color = T.grey7}
          title="Open new patient tab"
        >
          +
        </button>
      )}
    </div>
  );
}
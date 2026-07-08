/**
 * App.jsx  —  Holter ECG Dashboard root  (v10 — Phase 1 complete)
 *
 * FULLY MERGED: existing v9 + new Phase 1 additions.
 * Nothing removed from the existing version.
 *
 * Preserved from existing v9:
 *  ✓ getPatients() from utils/ecgApi.js (not bare fetch)
 *  ✓ h5Files state + fetch("/api/files") — passed to RecordsPage
 *  ✓ apiError state — passed to Sidebar as prop
 *  ✓ toggleTheme from useApp()
 *  ✓ tokens from useApp() — used for all colors
 *  ✓ Theme toggle button ☀️/🌙 in nav bar
 *  ✓ sidebarPatient derived from active ECG tab
 *  ✓ allTabsForBar computed with TAB_COLORS by index
 *  ✓ PatientTabs: activeIdx(number), onSelect(i), onClose(idx)
 *  ✓ Sidebar: activePatient(object), loading, apiError
 *  ✓ RecordsPage: patients, h5Files, onOpenPatient
 *  ✓ StatusBar: patientId, timeOffset, mode, apiOk
 *  ✓ closeTab(idx) by array index
 *  ✓ Empty ECG state with "+ Open Patient ECG" button
 *
 * Added in v10:
 *  + NotificationProvider wraps everything — toasts globally
 *  + useNotifications() → notify passed to pages
 *  + 📡 Acquire tab → DeviceConnect (was unreachable before)
 *  + SettingsPage receives notify prop
 *  + RecordsPage also receives notify prop
 *  + liveHr/liveTimeOffset/liveLeadCount/liveTotalSec from ECGViewer
 *    via onViewerStateChange — Sidebar and StatusBar now show real values
 *  + onStateChange prop on ECGViewer for active tab only
 */
// src/index.jsx or src/main.jsx — top of file
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import React, { useState, useEffect, useCallback } from "react";
import { useApp }         from "./context/AppContext";
import {
  NotificationProvider,
  useNotifications,
} from "./components/NotificationSystem";
import PatientTabs   from "./components/PatientTabs";
import PatientPicker from "./components/PatientPicker";
import Sidebar       from "./components/Sidebar";
import StatusBar     from "./components/StatusBar";
import RecordsPage   from "./pages/RecordsPage";
import ECGViewer     from "./pages/ECGViewer";
import SettingsPage  from "./pages/SettingsPage";
import DeviceConnect from "./pages/DeviceConnect";
import { getPatients } from "./utils/ecgApi";

const TAB_COLORS = ["#4f8ef7","#34c77b","#f5a623","#e06c75","#c678dd","#56b6c2"];

// ── Inner app — needs to be inside NotificationProvider to use notify ─────────
function AppInner() {
  const { theme, toggleTheme, tokens } = useApp();
  const { notify } = useNotifications();

  // ── Master patient list (from API) ────────────────────────────────────────
  const [patients, setPatients] = useState([
    { id:"P001", name:"Test Patient", age:45, sex:"M",
      dob:"1981-01-01", created_at:"2026-01-01" },
  ]);
  const [h5Files,  setH5Files]  = useState([]);
  const [apiError, setApiError] = useState(false);

  useEffect(() => {
    getPatients()
      .then(list => {
        if (list.length) setPatients(list);
        setApiError(false);
      })
      .catch(() => setApiError(true));

    fetch("/api/files")
      .then(r => r.json())
      .then(files => setH5Files(files))
      .catch(() => {});
  }, []);

  // ── Tab state ─────────────────────────────────────────────────────────────
  const [ecgTabs,    setEcgTabs]    = useState([]);
  const [activeTab,  setActiveTab]  = useState("records");
  const [showPicker, setShowPicker] = useState(false);

  // Open a patient ECG tab — same logic as existing, adds notify for limit
  const openPatient = useCallback((patient) => {
    setShowPicker(false);
    const exists = ecgTabs.find(t => t.id === patient.id);
    if (exists) {
      setActiveTab(patient.id);
      return;
    }
    if (ecgTabs.length >= 6) {
      notify({
        type:    "warning",
        title:   "Tab limit reached",
        message: "Maximum 6 patients open at once. Close a tab to open another.",
      });
      return;
    }
    setEcgTabs(prev => [
      ...prev,
      { id: patient.id, name: patient.name, patient },
    ]);
    setActiveTab(patient.id);
  }, [ecgTabs, notify]);

  // closeTab by index — preserving existing PatientTabs contract
  const closeTab = useCallback((idx) => {
    const tab  = ecgTabs[idx];
    const next = [...ecgTabs];
    next.splice(idx, 1);
    setEcgTabs(next);
    if (activeTab === tab.id) {
      setActiveTab(next[Math.min(idx, next.length - 1)]?.id ?? "records");
    }
  }, [ecgTabs, activeTab]);

  // ── Live state from active ECGViewer — fixes Sidebar/StatusBar ───────────
  const [liveHr,         setLiveHr]         = useState(72);
  const [liveTimeOffset, setLiveTimeOffset] = useState(0);
  const [liveLeadCount,  setLiveLeadCount]  = useState(0);
  const [liveTotalSec,   setLiveTotalSec]   = useState(172800);

  const onViewerStateChange = useCallback((state) => {
    setLiveHr(state.hr         ?? 72);
    setLiveTimeOffset(state.timeOffset ?? 0);
    setLiveLeadCount(state.leadCount   ?? 0);
    setLiveTotalSec(state.totalSec     ?? 172800);
  }, []);

  // ── Derived values (preserving existing patterns) ─────────────────────────
  const sidebarPatient = ecgTabs.find(t => t.id === activeTab)?.patient
                      ?? patients[0];

  const allTabsForBar = ecgTabs.map((t, i) => ({
    id:    t.id,
    name:  t.name,
    color: TAB_COLORS[i % TAB_COLORS.length],
  }));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      display:       "flex",
      flexDirection: "column",
      height:        "100vh",
      background:    tokens.bg,
      fontFamily:    "'IBM Plex Sans', sans-serif",
      overflow:      "hidden",
    }}>

      {/* Patient picker modal */}
      {showPicker && (
        <PatientPicker
          patients={patients}
          openIds={ecgTabs.map(t => t.id)}
          onSelect={openPatient}
          onClose={() => setShowPicker(false)}
        />
      )}

      {/* ── Top navigation bar ──────────────────────────────────────────── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        background:   tokens.surface,
        borderBottom: `1px solid ${tokens.border}`,
        padding:      "0 0 0 0",
        flexShrink:   0,
      }}>

        {/* App logo */}
        <div style={{
          padding:        "0 16px",
          borderRight:    "1px solid #181818",
          display:        "flex",
          flexDirection:  "column",
          justifyContent: "center",
          height:         36,
          flexShrink:     0,
        }}>
          <span style={{
            fontFamily:    "'Share Tech Mono', monospace",
            fontSize:      11,
            color:         tokens.accent,
            letterSpacing: "0.12em",
          }}>
            HOLTER ECG
          </span>
        </div>

        {/* Records tab — always present */}
        <div
          onClick={() => setActiveTab("records")}
          style={{
            padding:      "0 16px",
            height:        36,
            display:       "flex",
            alignItems:    "center",
            cursor:        "pointer",
            borderRight:   "1px solid #181818",
            borderBottom:  activeTab === "records"
              ? `2px solid ${tokens.accent}`
              : "2px solid transparent",
            background:    activeTab === "records" ? tokens.surface2 : "transparent",
          }}
        >
          <span style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize:   11,
            color:      activeTab === "records" ? tokens.accent : tokens.textMuted,
          }}>
            ☰ Records
          </span>
        </div>

        {/* Acquire tab — DeviceConnect now reachable */}
        <div
          onClick={() => setActiveTab("acquire")}
          style={{
            padding:      "0 16px",
            height:        36,
            display:       "flex",
            alignItems:    "center",
            cursor:        "pointer",
            borderRight:   "1px solid #181818",
            borderBottom:  activeTab === "acquire"
              ? `2px solid ${tokens.accent}`
              : "2px solid transparent",
            background:    activeTab === "acquire" ? tokens.surface2 : "transparent",
          }}
        >
          <span style={{
            fontFamily: "'Share Tech Mono', monospace",
            fontSize:   11,
            color:      activeTab === "acquire" ? tokens.accent : tokens.textMuted,
          }}>
            📡 Acquire
          </span>
        </div>

        {/* Patient ECG tabs — same contract as existing */}
        <PatientTabs
          tabs={allTabsForBar}
          activeIdx={ecgTabs.findIndex(t => t.id === activeTab)}
          onSelect={i => setActiveTab(ecgTabs[i].id)}
          onAdd={() => setShowPicker(true)}
          onClose={closeTab}
        />

        {/* Right side: theme toggle + settings — preserved exactly */}
        <div style={{
          marginLeft:  "auto",
          display:     "flex",
          alignItems:  "center",
          borderLeft:  `1px solid ${tokens.border}`,
          paddingLeft: 0,
        }}>

          {/* Theme toggle ☀️/🌙 — preserved from existing */}
          <button
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            style={{
              height:      36,
              padding:     "0 14px",
              background:  "transparent",
              border:      "none",
              cursor:      "pointer",
              fontSize:    14,
              borderRight: `1px solid ${tokens.border}`,
              color:       tokens.textSecondary,
              transition:  "color 0.15s",
            }}
            onMouseEnter={e => (e.currentTarget.style.color = tokens.textPrimary)}
            onMouseLeave={e => (e.currentTarget.style.color = tokens.textSecondary)}
          >
          <i
            className={theme === "dark" ? "ti ti-sun" : "ti ti-moon"}
            style={{
              fontSize: 15,
              pointerEvents: "none",
              color: theme === "dark" ? "#d0dc4e" : "#506f02",
            }}
            aria-hidden="false"
          />
          </button>

          {/* Settings nav item */}
          <div
            onClick={() => setActiveTab("settings")}
            style={{
              height:       36,
              padding:      "0 16px",
              display:      "flex",
              alignItems:   "center",
              cursor:       "pointer",
              borderBottom: activeTab === "settings"
                ? `2px solid ${tokens.accent}`
                : "2px solid transparent",
              background:   activeTab === "settings" ? tokens.surface2 : "transparent",
            }}
          >
            <span style={{
              fontFamily: "'Share Tech Mono', monospace",
              fontSize:   11,
              color:      activeTab === "settings" ? tokens.accent : tokens.textMuted,
            }}>
              ⚙ Settings
            </span>
          </div>
        </div>
      </div>

      {/* ── Main body ───────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>

        {/* Sidebar — same props as existing + live values instead of hardcoded */}
        {activeTab !== "records"  &&
         activeTab !== "settings" &&
         activeTab !== "acquire"  && (
          <Sidebar
            patients={patients}
            activePatient={sidebarPatient}
            onSelectPatient={openPatient}
            hr={liveHr}
            timeOffset={liveTimeOffset}
            totalDuration={liveTotalSec}
            loading={false}
            apiError={apiError}
          />
        )}

        {/* Page content */}
        <div style={{
          flex:          1,
          display:       "flex",
          flexDirection: "column",
          overflow:      "hidden",
          minWidth:      0,
        }}>

          {/* Settings — receives notify */}
          {activeTab === "settings" && (
            <SettingsPage notify={notify} />
          )}

          {/* DeviceConnect — was unreachable, now shows on Acquire tab */}
          {activeTab === "acquire" && (
            <DeviceConnect notify={notify} />
          )}

          {/* Records — receives h5Files (preserved) + notify (new) */}
          {activeTab === "records" && (
            <RecordsPage
              patients={patients}
              h5Files={h5Files}
              onOpenPatient={openPatient}
              notify={notify}
              tokens={tokens}
              theme={theme}
            />
          )}

          {/* ECG viewers — all rendered, hidden inactive (preserves state) */}
          {ecgTabs.map((tab, i) => (
            <div
              key={tab.id}
              style={{
                display:       activeTab === tab.id ? "flex" : "none",
                flexDirection: "column",
                flex:           1,
                overflow:      "hidden",
              }}
            >
              <ECGViewer
                patient={tab.patient}
                tabColor={TAB_COLORS[i % TAB_COLORS.length]}
                notify={notify}
                onStateChange={
                  activeTab === tab.id ? onViewerStateChange : undefined
                }
              />
            </div>
          ))}

          {/* Empty state — preserved from existing */}
          {ecgTabs.length === 0 &&
           activeTab !== "records" &&
           activeTab !== "settings" &&
           activeTab !== "acquire" && (
            <div style={{
              flex:           1,
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
            }}>
              <div style={{ textAlign: "center" }}>
                <div style={{
                  fontFamily:   "'Share Tech Mono', monospace",
                  fontSize:     12,
                  color:        "#2a2a2a",
                  marginBottom: 10,
                }}>
                  No ECG tab open
                </div>
                <button
                  onClick={() => setShowPicker(true)}
                  style={{
                    fontFamily:   "'Share Tech Mono', monospace",
                    fontSize:     11,
                    background:   "rgba(79,142,247,0.1)",
                    border:       "1px solid rgba(79,142,247,0.3)",
                    color:        "#4f8ef7",
                    borderRadius: 5,
                    padding:      "8px 16px",
                    cursor:       "pointer",
                  }}
                >
                  + Open Patient ECG
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer — StatusBar same props as existing, timeOffset now live */}
      <StatusBar
        patientId={sidebarPatient?.id ?? "—"}
        timeOffset={liveTimeOffset}
        mode={liveLeadCount === 12 ? "12" : liveLeadCount > 0 ? "3" : "—"}
        apiOk={!apiError}
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

// NotificationProvider wraps AppInner so useNotifications() works inside it
export default function App() {
  return (
    <NotificationProvider>
      <AppInner />
    </NotificationProvider>
  );
}
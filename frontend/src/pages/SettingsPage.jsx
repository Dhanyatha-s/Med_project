/**
 * SettingsPage.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Clinical-grade settings page for Holter Monitor Analysis System (HMAS).
 *
 * Fixes in this version:
 *  ✅ All fields are now fully editable — setProfile/setSetting wired correctly
 *  ✅ Theme toggle in Display panel now calls toggleTheme from useApp()
 *  ✅ Logo upload in Facility panel — stored as base64 in profile.logoBase64
 *     Used by PDF report generation and can be read by sidebar
 *  ✅ setProfile wrapper handles both (key,val) and object-spread signatures
 *  ✅ System priority buttons use Tabler icons (no arrow characters)
 *
 * AppContext surface used:
 *   theme, toggleTheme, settings, setSetting, profile, setProfile
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useApp } from "../context/AppContext";

const MONO  = { fontFamily: "'Share Tech Mono', 'Consolas', monospace" };
const BLUE  = "#378ADD";
const GREEN = "#34c77b";
const MUTED = "#888";

// ─── Shared style factories ───────────────────────────────────────────────────
const inputStyle = (theme) => ({
  width:        "100%",
  height:       30,
  background:   theme === "dark" ? "#111" : "#f5f5f5",
  border:       `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
  borderRadius: 5,
  color:        theme === "dark" ? "#ccc" : "#222",
  fontSize:     12,
  padding:      "0 9px",
  boxSizing:    "border-box",
  outline:      "none",
  fontFamily:   "inherit",
  transition:   "border-color 0.12s",
});

const labelStyle = {
  ...MONO,
  fontSize:      10,
  color:         MUTED,
  display:       "block",
  marginBottom:  4,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

const dividerStyle = (theme) => ({
  fontSize:      10,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color:         theme === "dark" ? "#444" : "#aaa",
  fontFamily:    "'Share Tech Mono', 'Consolas', monospace",
  marginBottom:  8,
  marginTop:     20,
  paddingBottom: 6,
  borderBottom:  `0.5px solid ${theme === "dark" ? "#1e1e1e" : "#e0e0e0"}`,
});

const saveBtnStyle = (theme) => ({
  ...MONO,
  height:       30,
  padding:      "0 22px",
  fontSize:     11,
  letterSpacing: "0.06em",
  background:   theme === "dark"
    ? "rgba(52,199,123,0.15)" : "rgba(52,199,123,0.10)",
  border:       "0.5px solid rgba(52,199,123,0.5)",
  color:        GREEN,
  borderRadius: 5,
  cursor:       "pointer",
  display:      "flex",
  alignItems:   "center",
  gap:          6,
  transition:   "all 0.15s",
});

const ghostBtnStyle = (theme) => ({
  ...MONO,
  height:       28,
  padding:      "0 14px",
  fontSize:     10,
  letterSpacing: "0.05em",
  background:   "transparent",
  border:       `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
  color:        MUTED,
  borderRadius: 5,
  cursor:       "pointer",
  display:      "flex",
  alignItems:   "center",
  gap:          6,
});

// ─── Reusable components ──────────────────────────────────────────────────────

function SectionDivider({ title, theme }) {
  return <div style={dividerStyle(theme)}>{title}</div>;
}

function Field({ label, value, onChange, type = "text",
                 min, max, step, unit, hint, readOnly, theme, mono }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <input
          type={type}
          value={value ?? ""}
          readOnly={readOnly}
          onChange={e =>
            onChange && onChange(type === "number" ? +e.target.value : e.target.value)
          }
          min={min} max={max} step={step}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={{
            ...inputStyle(theme),
            flex:       1,
            fontFamily: mono ? "'Share Tech Mono','Consolas',monospace" : "inherit",
            fontSize:   mono ? 11 : 12,
            borderColor: focused ? BLUE : (theme === "dark" ? "#2a2a2a" : "#d4d4d4"),
            color:      readOnly ? MUTED : (theme === "dark" ? "#ccc" : "#222"),
            cursor:     readOnly ? "default" : "text",
          }}
        />
        {unit && (
          <span style={{ ...MONO, fontSize: 10, color: MUTED,
            flexShrink: 0, minWidth: 28 }}>
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <span style={{ fontSize: 10, color: MUTED, marginTop: 3,
          display: "block", fontStyle: "italic", lineHeight: 1.5 }}>
          {hint}
        </span>
      )}
    </div>
  );
}

function SelectField({ label, value, onChange, options, theme }) {
  const [focused, setFocused] = useState(false);
  return (
    <div>
      <label style={labelStyle}>{label}</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          ...inputStyle(theme),
          appearance:  "auto",
          cursor:      "pointer",
          borderColor: focused ? BLUE : (theme === "dark" ? "#2a2a2a" : "#d4d4d4"),
        }}
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, checked, onChange, theme }) {
  return (
    <label style={{
      display:    "flex",
      alignItems: "center",
      gap:        10,
      cursor:     "pointer",
      userSelect: "none",
    }}>
      <div style={{ position: "relative", width: 34, height: 19, flexShrink: 0 }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={e => onChange(e.target.checked)}
          style={{ opacity: 0, width: 0, height: 0, position: "absolute" }}
        />
        <div style={{
          position:     "absolute",
          inset:        0,
          borderRadius: 10,
          background:   checked ? BLUE : (theme === "dark" ? "#2a2a2a" : "#ccc"),
          transition:   "background 0.2s",
        }} />
        <div style={{
          position:     "absolute",
          top:          3,
          left:         checked ? 17 : 3,
          width:        13,
          height:       13,
          borderRadius: "50%",
          background:   "#fff",
          transition:   "left 0.2s",
          boxShadow:    "0 1px 2px rgba(0,0,0,0.2)",
        }} />
      </div>
      <span style={{ fontSize: 12, color: theme === "dark" ? "#ccc" : "#444" }}>
        {label}
      </span>
    </label>
  );
}

function FieldGrid({ cols = 2, children }) {
  return (
    <div style={{
      display:             "grid",
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      gap:                 "14px 18px",
      marginTop:           12,
    }}>
      {children}
    </div>
  );
}

function MetricCard({ label, value, accent, theme }) {
  return (
    <div style={{
      background:   theme === "dark" ? "#0f0f0f" : "#f7f7f7",
      border:       `0.5px solid ${theme === "dark" ? "#1e1e1e" : "#e0e0e0"}`,
      borderRadius: 6,
      padding:      "10px 13px",
    }}>
      <div style={{ ...MONO, fontSize: 9, color: MUTED,
        marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ ...MONO, fontSize: 12,
        color: accent ?? (theme === "dark" ? "#bbb" : "#333") }}>
        {value ?? "—"}
      </div>
    </div>
  );
}

// Save row with icon and feedback
function SaveRow({ onSave, saveLabel = "Save", savedLabel = "Saved", theme }) {
  const [saved, setSaved] = useState(false);
  const handle = () => {
    onSave?.();
    setSaved(true);
    setTimeout(() => setSaved(false), 2400);
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 20 }}>
      <button onClick={handle} style={saveBtnStyle(theme)}>
        <i
          className={saved ? "ti ti-check" : "ti ti-device-floppy"}
          style={{ fontSize: 14 }}
          aria-hidden="true"
        />
        {saved ? savedLabel : saveLabel}
      </button>
      {saved && (
        <span style={{ ...MONO, fontSize: 10, color: GREEN, opacity: 0.8 }}>
          Saved to local storage
        </span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PANELS
// ─────────────────────────────────────────────────────────────────────────────

// ── Facility ──────────────────────────────────────────────────────────────────
function FacilityPanel({ profile, setProfile, theme, notify }) {
  const fileInputRef = useRef(null);

  // Logo upload — converts to base64 and stores in profile.logoBase64
  const handleLogoUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate — only image files, max 2MB
    if (!file.type.startsWith("image/")) {
      notify?.({ type: "error", title: "Invalid file",
        message: "Please upload an image file (PNG, JPG, SVG)." });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      notify?.({ type: "error", title: "File too large",
        message: "Logo must be under 2 MB." });
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      setProfile("logoBase64", ev.target.result);
      notify?.({ type: "success", title: "Logo uploaded",
        message: "Logo will appear on PDF reports." });
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const removeLogo = () => {
    setProfile("logoBase64", null);
    notify?.({ type: "info", title: "Logo removed" });
  };

  const borderC = theme === "dark" ? "#1e1e1e" : "#e0e0e0";

  return (
    <div>
      {/* ── Logo upload ─────────────────────────────────────────────────── */}
      <SectionDivider title="Hospital logo" theme={theme} />
      <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginTop: 12 }}>

        {/* Logo preview box — 120×60 fixed, clinical proportions */}
        <div style={{
          width:          120,
          height:         60,
          border:         `0.5px solid ${borderC}`,
          borderRadius:   5,
          background:     theme === "dark" ? "#0f0f0f" : "#f7f7f7",
          display:        "flex",
          alignItems:     "center",
          justifyContent: "center",
          flexShrink:     0,
          overflow:       "hidden",
        }}>
          {profile.logoBase64 ? (
            <img
              src={profile.logoBase64}
              alt="Hospital logo"
              style={{
                maxWidth:  "100%",
                maxHeight: "100%",
                objectFit: "contain",
              }}
            />
          ) : (
            <div style={{ textAlign: "center" }}>
              <i className="ti ti-building-hospital"
                style={{ fontSize: 22, color: borderC, display: "block",
                  marginBottom: 4 }}
                aria-hidden="true" />
              <span style={{ ...MONO, fontSize: 8, color: MUTED }}>
                No logo
              </span>
            </div>
          )}
        </div>

        {/* Upload controls */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 11, color: MUTED, lineHeight: 1.6, margin: 0 }}>
            Upload your hospital logo. It will appear on all generated PDF
            reports and the application sidebar.
            <br />
            <span style={{ ...MONO, fontSize: 9 }}>
              PNG, JPG or SVG · max 2 MB · recommended 300×100 px
            </span>
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <label style={{
              ...ghostBtnStyle(theme),
              cursor:     "pointer",
              userSelect: "none",
            }}>
              <i className="ti ti-upload"
                style={{ fontSize: 14 }} aria-hidden="true" />
              {profile.logoBase64 ? "Replace logo" : "Upload logo"}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                style={{ display: "none" }}
              />
            </label>
            {profile.logoBase64 && (
              <button
                onClick={removeLogo}
                style={{
                  ...ghostBtnStyle(theme),
                  borderColor: "rgba(192,57,43,0.35)",
                  color:       "#c0392b",
                }}
              >
                <i className="ti ti-trash"
                  style={{ fontSize: 14 }} aria-hidden="true" />
                Remove
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Facility fields ──────────────────────────────────────────────── */}
      <SectionDivider title="Facility profile" theme={theme} />
      <FieldGrid cols={2}>
        <Field label="Hospital name"
          value={profile.hospital ?? ""}
          onChange={v => setProfile("hospital", v)}
          theme={theme} />
        <Field label="Department"
          value={profile.department ?? ""}
          onChange={v => setProfile("department", v)}
          theme={theme} />
        <Field label="Attending physician"
          value={profile.doctor ?? ""}
          onChange={v => setProfile("doctor", v)}
          theme={theme} />
        <Field label="Medical license no."
          value={profile.licenseNo ?? ""}
          onChange={v => setProfile("licenseNo", v)}
          theme={theme} />
        <Field label="Contact phone"
          value={profile.phone ?? ""}
          onChange={v => setProfile("phone", v)}
          theme={theme} />
        <Field label="Address"
          value={profile.address ?? ""}
          onChange={v => setProfile("address", v)}
          theme={theme} />
      </FieldGrid>

      <SaveRow
        onSave={() =>
          notify?.({ type: "success", title: "Facility profile saved",
            message: "Used in PDF report headers and signature block." })
        }
        saveLabel="Save profile"
        savedLabel="Profile saved"
        theme={theme}
      />
      <p style={{ fontSize: 10, color: MUTED, marginTop: 10,
        fontStyle: "italic", lineHeight: 1.6 }}>
        These values print on every generated report header and physician
        signature block. The attending physician name also appears in the
        patient diary.
      </p>
    </div>
  );
}

// ── Display ───────────────────────────────────────────────────────────────────
function DisplayPanel({ settings, setSetting, theme, toggleTheme }) {
  return (
    <div>
      <SectionDivider title="ECG trace" theme={theme} />
      <FieldGrid cols={2}>
        <SelectField label="Default lead mode"
          value={String(settings.defaultMode ?? "12")}
          onChange={v => setSetting("defaultMode", v)}
          options={[
            { value: "12", label: "12-Lead" },
            { value: "3",  label: "3-Lead"  },
          ]}
          theme={theme}
        />
        <SelectField label="Paper speed"
          value={String(settings.paperSpeed ?? 25)}
          onChange={v => setSetting("paperSpeed", +v)}
          options={[
            { value: "25", label: "25 mm/s — Standard" },
            { value: "50", label: "50 mm/s — Fast"     },
          ]}
          theme={theme}
        />
        <SelectField label="Gain"
          value={String(settings.gain ?? 10)}
          onChange={v => setSetting("gain", +v)}
          options={[
            { value: "5",  label: "5 mm/mV — Low"      },
            { value: "10", label: "10 mm/mV — Standard" },
            { value: "20", label: "20 mm/mV — High"     },
          ]}
          theme={theme}
        />
        <div>
          <label style={labelStyle}>Trace thickness</label>
          <div style={{ display: "flex", alignItems: "center", gap: 10, height: 30 }}>
            <input
              type="range" min={0.5} max={3} step={0.25}
              value={settings.traceThickness ?? 1.5}
              onChange={e => setSetting("traceThickness", +e.target.value)}
              style={{ flex: 1, accentColor: BLUE, cursor: "pointer" }}
            />
            <span style={{ ...MONO, fontSize: 10, color: BLUE, minWidth: 42 }}>
              {(settings.traceThickness ?? 1.5).toFixed(2)} px
            </span>
          </div>
        </div>
      </FieldGrid>

      <SectionDivider title="Markers & overlay" theme={theme} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        <Toggle
          label="Show R-peak, RR interval, PR & QRS markers on Lead II"
          checked={settings.showMarkers ?? true}
          onChange={v => setSetting("showMarkers", v)}
          theme={theme}
        />
        <Toggle
          label="Show event markers (beats, arrhythmia flags)"
          checked={settings.showEventMarkers ?? true}
          onChange={v => setSetting("showEventMarkers", v)}
          theme={theme}
        />
        <Toggle
          label="Show ECG grid lines"
          checked={settings.showGrid ?? true}
          onChange={v => setSetting("showGrid", v)}
          theme={theme}
        />
      </div>

      <SectionDivider title="Appearance" theme={theme} />
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <i
            className={theme === "dark" ? "ti ti-moon" : "ti ti-sun"}
            style={{ fontSize: 16, color: MUTED }}
            aria-hidden="true"
          />
          <span style={{ fontSize: 12, color: MUTED }}>
            {theme === "dark" ? "Dark mode" : "Light mode"}
          </span>
        </div>
        {/* toggleTheme from useApp() — wired correctly */}
        <button
          onClick={toggleTheme}
          style={{
            ...MONO, fontSize: 10,
            background:   "transparent",
            border:       `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
            color:        BLUE,
            borderRadius: 5,
            padding:      "5px 16px",
            cursor:       "pointer",
            display:      "flex",
            alignItems:   "center",
            gap:          6,
          }}
        >
          <i
            className={theme === "dark" ? "ti ti-sun" : "ti ti-moon"}
            style={{ fontSize: 14 }}
            aria-hidden="true"
          />
          Switch to {theme === "dark" ? "light" : "dark"}
        </button>
      </div>
      <p style={{ fontSize: 10, color: MUTED, marginTop: 14,
        fontStyle: "italic", lineHeight: 1.6 }}>
        Display changes apply immediately. Toggle controls are per-session;
        the default at startup is controlled by this setting.
      </p>
    </div>
  );
}

// ── Analysis ──────────────────────────────────────────────────────────────────
function AnalysisPanel({ settings, setSetting, theme, notify }) {
  const T   = settings.thresholds ?? {};
  const set = (key, val) =>
    setSetting("thresholds", { ...(settings.thresholds ?? {}), [key]: val });

  return (
    <div>
      <SectionDivider title="Rate thresholds" theme={theme} />
      <FieldGrid cols={2}>
        <Field label="Max AF rate"
          type="number" min={200} max={600} step={10} unit="bpm"
          value={T.maxAfRate ?? 350}
          hint="Max ventricular rate during AF detection"
          onChange={v => set("maxAfRate", v)} theme={theme} />
        <Field label="Max tachycardia rate"
          type="number" min={100} max={250} step={5} unit="bpm"
          value={T.maxTachyRate ?? 150}
          hint="HR above this threshold = tachycardia"
          onChange={v => set("maxTachyRate", v)} theme={theme} />
        <Field label="Min bradycardia rate"
          type="number" min={30} max={80} step={5} unit="bpm"
          value={T.minBradyRate ?? 50}
          hint="HR below this threshold = bradycardia"
          onChange={v => set("minBradyRate", v)} theme={theme} />
        <Field label="Max N–N interval"
          type="number" min={1000} max={3000} step={50} unit="ms"
          value={T.longestNNms ?? 1500}
          hint="Longest normal-to-normal before flagging as pause"
          onChange={v => set("longestNNms", v)} theme={theme} />
        <Field label="Pause threshold (asystole)"
          type="number" min={1500} max={8000} step={100} unit="ms"
          value={T.longestPauseMs ?? 3000}
          hint="Pause exceeding this value is flagged"
          onChange={v => set("longestPauseMs", v)} theme={theme} />
      </FieldGrid>

      <SectionDivider title="ST segment — per channel" theme={theme} />
      <FieldGrid cols={3}>
        {[1, 2, 3].map(ch => (
          <Field key={`elev${ch}`} label={`Ch ${ch} max elevation`}
            type="number" min={0.05} max={1.0} step={0.05} unit="mV"
            value={T[`stElevation${ch}`] ?? 0.20}
            hint="Above this = elevation event"
            onChange={v => set(`stElevation${ch}`, v)} theme={theme} />
        ))}
        {[1, 2, 3].map(ch => (
          <Field key={`dep${ch}`} label={`Ch ${ch} max depression`}
            type="number" min={0.05} max={0.5} step={0.05} unit="mV"
            value={T[`stDepression${ch}`] ?? 0.10}
            hint="Below this = depression event"
            onChange={v => set(`stDepression${ch}`, v)} theme={theme} />
        ))}
      </FieldGrid>

      <SectionDivider title="Run detection" theme={theme} />
      <FieldGrid cols={2}>
        <Field label="Longest atrial run (SVT)"
          type="number" min={3} max={300} step={1} unit="beats"
          value={T.longestAtrialRun ?? 30}
          hint="Run longer than this = sustained SVT"
          onChange={v => set("longestAtrialRun", v)} theme={theme} />
        <Field label="Longest tachycardia run"
          type="number" min={3} max={300} step={1} unit="beats"
          value={T.longestTachyRun ?? 30}
          hint="Run longer than this = sustained VT"
          onChange={v => set("longestTachyRun", v)} theme={theme} />
        <Field label="Longest brady episode"
          type="number" min={3} max={120} step={1} unit="sec"
          value={T.longestBradyEpisodeSec ?? 10}
          hint="Bradycardia episode minimum duration"
          onChange={v => set("longestBradyEpisodeSec", v)} theme={theme} />
      </FieldGrid>

      <SaveRow
        onSave={() =>
          notify?.({ type: "success", title: "Thresholds saved",
            message: "Phase 2 analysis engine will use these values." })
        }
        saveLabel="Save thresholds"
        savedLabel="Thresholds saved"
        theme={theme}
      />
      <p style={{ fontSize: 10, color: MUTED, marginTop: 10,
        fontStyle: "italic", lineHeight: 1.6 }}>
        Values are stored in local storage and passed to the Phase 2 analysis
        engine on every analysis run.
      </p>
    </div>
  );
}

// ── Reports ───────────────────────────────────────────────────────────────────
function ReportsPanel({ settings, setSetting, theme, notify }) {
  return (
    <div>
      <SectionDivider title="Report output" theme={theme} />
      <FieldGrid cols={2}>
        <SelectField label="Default template"
          value={settings.reportTemplate ?? "standard"}
          onChange={v => setSetting("reportTemplate", v)}
          options={[
            { value: "standard",    label: "Standard Holter — 3 pg"  },
            { value: "abbreviated", label: "Abbreviated — 1 pg"       },
            { value: "full",        label: "Full diagnostic — 5 pg"   },
          ]}
          theme={theme}
        />
        <SelectField label="Header layout"
          value={settings.reportHeader ?? "logo"}
          onChange={v => setSetting("reportHeader", v)}
          options={[
            { value: "logo",     label: "With hospital logo" },
            { value: "textonly", label: "Text only"          },
          ]}
          theme={theme}
        />
      </FieldGrid>

      <SectionDivider title="Sections to include" theme={theme} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        {[
          { key: "rptSummary",   label: "Summary statistics (HR min / max / mean)"  },
          { key: "rptEvents",    label: "Arrhythmia event log"                       },
          { key: "rptST",        label: "ST segment analysis"                        },
          { key: "rptHRV",       label: "HRV analysis (optional)"                    },
          { key: "rptSignature", label: "Physician signature block"                  },
        ].map(({ key, label }) => (
          <Toggle
            key={key}
            label={label}
            checked={settings[key] ?? (key !== "rptHRV")}
            onChange={v => setSetting(key, v)}
            theme={theme}
          />
        ))}
      </div>

      <SaveRow
        onSave={() =>
          notify?.({ type: "success", title: "Report settings saved",
            message: "Next generated report will use these sections." })
        }
        saveLabel="Save report settings"
        savedLabel="Saved"
        theme={theme}
      />
    </div>
  );
}

// ── System ────────────────────────────────────────────────────────────────────
function SystemPanel({ theme, notify }) {
  const [info,    setInfo]    = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    try {
      const res  = await fetch("/api/system/priority");
      const data = await res.json();
      setInfo(data);
    } catch (e) {
      notify?.({ type: "error", title: "System info unavailable", message: e.message });
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => { fetchInfo(); }, [fetchInfo]);

  const setPriority = async (endpoint) => {
    try {
      const res  = await fetch(`/api/system/priority/${endpoint}`, { method: "POST" });
      const data = await res.json();
      notify?.({
        type:    data.success ? "success" : "warning",
        title:   data.success ? "Priority updated" : "Priority limited",
        message: data.message,
      });
      fetchInfo();
    } catch (e) {
      notify?.({ type: "error", title: "Priority change failed", message: e.message });
    }
  };

  const LEVEL_COLOR = {
    high:         GREEN,
    above_normal: BLUE,
    normal:       MUTED,
    unavailable:  "#e05050",
  };

  return (
    <div>
      <SectionDivider title="Process priority" theme={theme} />

      {loading && (
        <p style={{ ...MONO, fontSize: 10, color: MUTED, marginTop: 10 }}>
          Loading system info…
        </p>
      )}

      {info && (
        <div style={{
          display:             "grid",
          gridTemplateColumns: "1fr 1fr",
          gap:                 10,
          marginTop:           12,
        }}>
          <MetricCard label="Platform"       value={info.platform} theme={theme} />
          <MetricCard label="Process ID"     value={info.pid}      theme={theme} />
          <MetricCard label="Priority level"
            value={info.level?.replace(/_/g, " ").toUpperCase()}
            accent={LEVEL_COLOR[info.level] ?? MUTED}
            theme={theme}
          />
          <MetricCard label="Method"  value={info.method} theme={theme} />
          <MetricCard label="CPU usage"
            value={info.cpu_percent !== undefined
              ? `${info.cpu_percent.toFixed(1)} %` : "—"}
            theme={theme}
          />
          <MetricCard label="Memory"
            value={info.memory_mb !== undefined
              ? `${info.memory_mb} MB` : "—"}
            theme={theme}
          />
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 14 }}>
        <button
          onClick={() => setPriority("high")}
          style={{
            ...ghostBtnStyle(theme),
            borderColor: "rgba(52,199,123,0.4)",
            color:       GREEN,
          }}
        >
          <i className="ti ti-arrow-up"
            style={{ fontSize: 14 }} aria-hidden="true" />
          Raise to high
        </button>
        <button onClick={() => setPriority("reset")} style={ghostBtnStyle(theme)}>
          <i className="ti ti-arrow-down"
            style={{ fontSize: 14 }} aria-hidden="true" />
          Reset to normal
        </button>
        <button onClick={fetchInfo} style={ghostBtnStyle(theme)}>
          <i className="ti ti-refresh"
            style={{ fontSize: 14 }} aria-hidden="true" />
          Refresh
        </button>
      </div>

      <div style={{
        marginTop:    16,
        padding:      "10px 14px",
        background:   theme === "dark"
          ? "rgba(55,138,221,0.05)" : "rgba(55,138,221,0.04)",
        border:       `0.5px solid ${theme === "dark"
          ? "rgba(55,138,221,0.12)" : "rgba(55,138,221,0.2)"}`,
        borderRadius: 5,
      }}>
        <div style={{ ...MONO, fontSize: 9, color: MUTED,
          marginBottom: 6, letterSpacing: "0.08em", textTransform: "uppercase" }}>
          Platform notes
        </div>
        <p style={{ fontSize: 10, color: MUTED, lineHeight: 1.7, margin: 0 }}>
          <strong style={{ color: theme === "dark" ? "#ccc" : "#444" }}>Windows:</strong>{" "}
          Uses psutil HIGH_PRIORITY_CLASS. Falls back to ABOVE_NORMAL if admin
          rights are unavailable.<br />
          <strong style={{ color: theme === "dark" ? "#ccc" : "#444" }}>Linux:</strong>{" "}
          Uses nice(−10). Requires root for full −10; falls back to nice(−5).<br />
          <strong style={{ color: theme === "dark" ? "#ccc" : "#444" }}>macOS:</strong>{" "}
          Same as Linux. Use sudo if full priority is needed.
        </p>
      </div>

      <SectionDivider title="Data paths" theme={theme} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        <Field label="Data directory"
          value={info?.data_dir ?? "C:\\HolterData\\recordings"}
          readOnly mono theme={theme} />
        <Field label="Database path"
          value={info?.db_path ?? "C:\\HolterData\\hmas.db"}
          readOnly mono theme={theme} />
      </div>
      <p style={{ fontSize: 10, color: MUTED, marginTop: 8, fontStyle: "italic" }}>
        Paths are set at installation. Edit hmas.config.json to relocate.
      </p>
    </div>
  );
}

// ── About ─────────────────────────────────────────────────────────────────────
function AboutPanel({ theme }) {
  const APP_META = {
    application: "HMAS — Holter Monitor Analysis System",
    version:     "2.1.0",
    buildDate:   "2025-12-14",
    buildId:     "a3f9c12",
    licenseType: "Clinical Site",
    seats:       "5",
    electron:    "28.2.1",
    node:        "20.11.0",
    chromium:    "120.0.6099.234",
    python:      "3.11.7",
  };

  return (
    <div>
      <SectionDivider title="Software information" theme={theme} />
      <div style={{
        display:             "grid",
        gridTemplateColumns: "1fr 1fr",
        gap:                 10,
        marginTop:           12,
      }}>
        <MetricCard label="Application"    value={APP_META.application}  theme={theme} />
        <MetricCard label="Version"        value={APP_META.version}       theme={theme} />
        <MetricCard label="Build date"     value={APP_META.buildDate}     theme={theme} />
        <MetricCard label="Build ID"       value={APP_META.buildId}       theme={theme} />
        <MetricCard label="License type"   value={APP_META.licenseType}   theme={theme} />
        <MetricCard label="Licensed seats" value={APP_META.seats}         theme={theme} />
      </div>

      <SectionDivider title="License" theme={theme} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
        <Field label="License key"
          value="HMAS-SITE-2024-KA-9F2A"
          readOnly mono theme={theme} />
        <Field label="Licensed to"
          value="Narayana Multispecialty Hospital, Bengaluru"
          readOnly theme={theme} />
        <Field label="License expiry"
          value="2026-12-31"
          readOnly mono theme={theme} />
      </div>

      <SectionDivider title="Runtime" theme={theme} />
      <div style={{
        display:             "grid",
        gridTemplateColumns: "1fr 1fr",
        gap:                 10,
        marginTop:           12,
      }}>
        <MetricCard label="Electron"       value={APP_META.electron} theme={theme} />
        <MetricCard label="Node.js"        value={APP_META.node}     theme={theme} />
        <MetricCard label="Chromium"       value={APP_META.chromium} theme={theme} />
        <MetricCard label="Python backend" value={APP_META.python}   theme={theme} />
      </div>

      <p style={{ fontSize: 10, color: MUTED, marginTop: 16,
        fontStyle: "italic", lineHeight: 1.6 }}>
        Software version and build ID must be recorded in all clinical incident
        reports for regulatory traceability. Do not remove this section.
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

const NAV_ITEMS = [
  { id: "facility", label: "Facility", icon: "ti-building-hospital" },
  { id: "display",  label: "Display",  icon: "ti-device-desktop-analytics" },
  { id: "analysis", label: "Analysis", icon: "ti-activity" },
  { id: "reports",  label: "Reports",  icon: "ti-file-description" },
  { id: "system",   label: "System",   icon: "ti-server" },
  { id: "about",    label: "About",    icon: "ti-info-circle" },
];
const NAV_DIVIDER_AFTER = "reports";

export default function SettingsPage({ notify }) {
  const { theme, toggleTheme, settings, setSetting, profile, setProfile } = useApp();
  const [activeTab, setActiveTab] = useState("facility");

  // AppContext.setProfile takes a partial object: setProfile({ key: value })
  // This wrapper lets all panels call setProfile("key", value) uniformly.
  const handleSetProfile = useCallback((key, value) => {
    setProfile({ [key]: value });
  }, [setProfile]);

  const bg        = theme === "dark" ? "#090909" : "#f7f7f7";
  const sidebarBg = theme === "dark" ? "#0c0c0c" : "#f0f0f0";
  const borderC   = theme === "dark" ? "#1a1a1a" : "#e0e0e0";
  const text      = theme === "dark" ? "#bbb"    : "#333";

  return (
    <div style={{
      flex:       1,
      display:    "flex",
      overflow:   "hidden",
      background: bg,
      color:      text,
      fontFamily: "'IBM Plex Sans', 'Segoe UI', sans-serif",
      fontSize:   13,
    }}>

      {/* ── Left sidebar ─────────────────────────────────────────────────── */}
      <aside style={{
        width:         150,
        flexShrink:    0,
        background:    sidebarBg,
        borderRight:   `0.5px solid ${borderC}`,
        display:       "flex",
        flexDirection: "column",
      }}>
        <div style={{
          padding:      "16px 14px 12px",
          borderBottom: `0.5px solid ${borderC}`,
        }}>
          <div style={{
            ...MONO, fontSize: 11,
            color:         theme === "dark" ? "#ccc" : "#555",
            letterSpacing: "0.09em",
            textTransform: "uppercase",
          }}>
            Settings
          </div>
          <div style={{ ...MONO, fontSize: 9, color: MUTED, marginTop: 3 }}>
            HMAS v2.1.0
          </div>
        </div>

        <nav style={{ flex: 1, padding: "8px 0" }}>
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <React.Fragment key={item.id}>
                <button
                  onClick={() => setActiveTab(item.id)}
                  style={{
                    display:    "flex",
                    alignItems: "center",
                    gap:        9,
                    width:      "100%",
                    padding:    "8px 14px",
                    background: active
                      ? (theme === "dark" ? "rgba(55,138,221,0.07)" : "rgba(55,138,221,0.06)")
                      : "transparent",
                    border:      "none",
                    borderLeft:  active ? `2px solid ${BLUE}` : "2px solid transparent",
                    color:       active ? BLUE : MUTED,
                    fontSize:    12,
                    fontWeight:  active ? 500 : 400,
                    cursor:      "pointer",
                    textAlign:   "left",
                    fontFamily:  "inherit",
                    transition:  "background 0.1s, color 0.1s",
                    letterSpacing: "0.01em",
                  }}
                  onMouseEnter={e => {
                    if (!active) {
                      e.currentTarget.style.background =
                        theme === "dark" ? "rgba(255,255,255,0.03)" : "rgba(0,0,0,0.03)";
                      e.currentTarget.style.color = theme === "dark" ? "#ccc" : "#333";
                    }
                  }}
                  onMouseLeave={e => {
                    if (!active) {
                      e.currentTarget.style.background = "transparent";
                      e.currentTarget.style.color = MUTED;
                    }
                  }}
                >
                  <i
                    className={`ti ${item.icon}`}
                    style={{ fontSize: 15, flexShrink: 0, width: 16 }}
                    aria-hidden="true"
                  />
                  {item.label}
                </button>
                {item.id === NAV_DIVIDER_AFTER && (
                  <div style={{
                    height:     "0.5px",
                    background: borderC,
                    margin:     "6px 14px",
                  }} />
                )}
              </React.Fragment>
            );
          })}
        </nav>
      </aside>

      {/* ── Content area ─────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflowY: "auto", padding: "22px 26px" }}>
        {activeTab === "facility" && (
          <FacilityPanel
            profile    = {profile}
            setProfile = {handleSetProfile}
            theme      = {theme}
            notify     = {notify}
          />
        )}
        {activeTab === "display" && (
          <DisplayPanel
            settings     = {settings}
            setSetting   = {setSetting}
            theme        = {theme}
            toggleTheme  = {toggleTheme}
          />
        )}
        {activeTab === "analysis" && (
          <AnalysisPanel
            settings   = {settings}
            setSetting = {setSetting}
            theme      = {theme}
            notify     = {notify}
          />
        )}
        {activeTab === "reports" && (
          <ReportsPanel
            settings   = {settings}
            setSetting = {setSetting}
            theme      = {theme}
            notify     = {notify}
          />
        )}
        {activeTab === "system" && (
          <SystemPanel theme={theme} notify={notify} />
        )}
        {activeTab === "about" && (
          <AboutPanel theme={theme} />
        )}
      </main>
    </div>
  );
}
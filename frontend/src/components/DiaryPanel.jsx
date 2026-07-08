/**
 * DiaryPanel.jsx  —  Patient Diary & Annotations
 * ─────────────────────────────────────────────────────────────────────────────
 * Redesign rationale (v3):
 *
 *  REMOVED sidebar nav — Doctor / Device / Auto filters had no real function
 *  since all entries currently come from one source. Sidebar was wasting 130px
 *  of panel width and confusing the operator.
 *
 *  ADDED compact filter pill row — appears only when multiple annotation types
 *  exist in the current patient's diary. Stays hidden otherwise (no clutter).
 *
 *  FIXED source label — instead of raw "doctor" string, reads the attending
 *  physician name from AppContext profile (settings → Facility → doctor field).
 *  Falls back to "doctor" if profile not set.
 *
 *  INCREASED panel height — removed the sidebar header overhead, giving the
 *  annotation list and form more vertical space.
 *
 *  KEPT expand/compress (360 ↔ 620px) and close (X) in header.
 *  KEPT Import button in the form footer — it belongs there, not in a sidebar.
 *
 * Props (unchanged):
 *   patientId, open, onClose, timeOffset, onSeek, onMarkersChange, notify
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from "react";
import { useApp } from "../context/AppContext";

// ─── Design tokens ────────────────────────────────────────────────────────────
const MONO  = { fontFamily: "'Share Tech Mono', 'Consolas', monospace" };
const BLUE  = "#378ADD";
const GREEN = "#34c77b";
const MUTED = "#888";

// ─── Annotation type config ───────────────────────────────────────────────────
const TYPE_CONFIG = {
  diary: {
    border:      GREEN,
    bg:          "rgba(52,199,123,0.06)",
    badgeBg:     "rgba(52,199,123,0.12)",
    badgeBorder: "rgba(52,199,123,0.30)",
    label:       "Diary",
    filterIcon:  "ti-notes",
  },
  device: {
    border:      BLUE,
    bg:          "rgba(55,138,221,0.06)",
    badgeBg:     "rgba(55,138,221,0.10)",
    badgeBorder: "rgba(55,138,221,0.28)",
    label:       "Device",
    filterIcon:  "ti-device-heart-monitor",
  },
  auto: {
    border:      "#555",
    bg:          "rgba(80,80,80,0.05)",
    badgeBg:     "transparent",
    badgeBorder: "#2a2a2a",
    label:       "Auto",
    filterIcon:  "ti-robot",
  },
};

// ─── Style helpers ────────────────────────────────────────────────────────────
const ghostBtn = (theme) => ({
  ...MONO,
  height:        26,
  padding:       "0 10px",
  fontSize:      10,
  letterSpacing: "0.04em",
  background:    "transparent",
  border:        `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
  color:         MUTED,
  borderRadius:  4,
  cursor:        "pointer",
  display:       "flex",
  alignItems:    "center",
  gap:           5,
});

const primaryBtn = (theme) => ({
  ...ghostBtn(theme),
  borderColor: "rgba(55,138,221,0.40)",
  background:  "rgba(55,138,221,0.07)",
  color:       BLUE,
});

const inputSt = (theme) => ({
  height:       30,
  background:   theme === "dark" ? "#111" : "#f5f5f5",
  border:       `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
  borderRadius: 4,
  color:        theme === "dark" ? "#ccc" : "#222",
  fontSize:     12,
  padding:      "0 9px",
  boxSizing:    "border-box",
  outline:      "none",
  fontFamily:   "inherit",
});

const labelSt = {
  ...MONO,
  fontSize:      10,
  color:         MUTED,
  display:       "block",
  marginBottom:  4,
  letterSpacing: "0.07em",
  textTransform: "uppercase",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmtHMS(sec) {
  if (sec == null || isNaN(sec)) return "—";
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(sec % 60)).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// ─── Header icon button (close / expand) ─────────────────────────────────────
function HeaderIconBtn({ icon, onClick, title, theme, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        width:          26,
        height:         26,
        padding:        0,
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        background:     "transparent",
        border:         `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
        borderRadius:   4,
        cursor:         "pointer",
        color:          danger ? "#c0392b" : MUTED,
        flexShrink:     0,
        transition:     "background 0.1s, color 0.1s, border-color 0.1s",
      }}
      onMouseEnter={e => {
        e.currentTarget.style.color = danger ? "#e05050"
          : (theme === "dark" ? "#ccc" : "#333");
        e.currentTarget.style.borderColor = danger
          ? "rgba(192,57,43,0.45)"
          : (theme === "dark" ? "#444" : "#bbb");
        e.currentTarget.style.background = danger
          ? "rgba(192,57,43,0.07)"
          : (theme === "dark" ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.04)");
      }}
      onMouseLeave={e => {
        e.currentTarget.style.color      = danger ? "#c0392b" : MUTED;
        e.currentTarget.style.borderColor = theme === "dark" ? "#2a2a2a" : "#d4d4d4";
        e.currentTarget.style.background  = "transparent";
      }}
    >
      <i className={`ti ${icon}`}
        style={{ fontSize: 14, pointerEvents: "none" }}
        aria-hidden="true" />
    </button>
  );
}

// ─── Type badge pill ──────────────────────────────────────────────────────────
function TypeBadge({ type }) {
  const tc = TYPE_CONFIG[type] ?? TYPE_CONFIG.auto;
  return (
    <span style={{
      ...MONO,
      fontSize:      9,
      letterSpacing: "0.06em",
      padding:       "1px 6px",
      borderRadius:  3,
      background:    tc.badgeBg,
      border:        `0.5px solid ${tc.badgeBorder}`,
      color:         tc.border,
    }}>
      {tc.label}
    </span>
  );
}

// ─── Single annotation row ────────────────────────────────────────────────────
function AnnotationRow({
  ann, doctorName, onEdit, onDelete, onSeek,
  isEditing, editNote, onEditNoteChange, onEditSave, onEditCancel,
  theme,
}) {
  const tc    = TYPE_CONFIG[ann.type] ?? TYPE_CONFIG.auto;
  const hasTs = ann.timestamp_sec != null;

  // Resolve display name for source
  // Use the stored ann.source field — set at creation time with the actual
  // doctor's name. This means changing the session doctor name never
  // retroactively alters attribution on previously written notes.
  // doctorName is only used as a fallback if source is missing (old data).
  const sourceName = ann.type === "diary"
    ? (ann.source && ann.source !== "doctor" ? ann.source : (doctorName || "Doctor"))
    : ann.type === "device"
    ? (ann.source || "Holter device")
    : "System";

  return (
    <div
      style={{
        borderLeft:   `2px solid ${tc.border}`,
        background:   tc.bg,
        borderRadius: "0 5px 5px 0",
        padding:      "9px 11px",
        marginBottom: 8,
        cursor:       hasTs ? "pointer" : "default",
      }}
      onClick={() => hasTs && onSeek?.(ann.timestamp_sec)}
      title={hasTs ? `Jump to ${fmtHMS(ann.timestamp_sec)}` : ""}
    >
      {/* Row header */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        gap:          7,
        marginBottom: 5,
        flexWrap:     "wrap",
      }}>
        <TypeBadge type={ann.type} />

        {/* Timestamp chip */}
        {hasTs && (
          <span style={{
            ...MONO, fontSize: 10, color: BLUE,
            display: "flex", alignItems: "center", gap: 4,
          }}>
            <i className="ti ti-clock"
              style={{ fontSize: 12 }} aria-hidden="true" />
            {fmtHMS(ann.timestamp_sec)}
          </span>
        )}

        {/* Source name — shows physician name for diary entries */}
        <span style={{
          ...MONO, fontSize: 9, color: MUTED,
          marginLeft: "auto", opacity: 0.8,
          display: "flex", alignItems: "center", gap: 4,
        }}>
          <i className={`ti ${
              ann.type === "diary"   ? "ti-user-circle" :
              ann.type === "device" ? "ti-device-heart-monitor" :
              "ti-robot"
            }`}
            style={{ fontSize: 12 }} aria-hidden="true" />
          {sourceName}
          <span style={{ opacity: 0.5 }}>·</span>
          {ann.created_at?.slice(0, 16) ?? ""}
        </span>
      </div>

      {/* Note body */}
      {isEditing ? (
        <div onClick={e => e.stopPropagation()}>
          <textarea
            value={editNote}
            onChange={e => onEditNoteChange(e.target.value)}
            autoFocus
            rows={3}
            style={{
              width:        "100%",
              background:   theme === "dark" ? "#0e0e0e" : "#f9f9f9",
              border:       `0.5px solid ${BLUE}`,
              borderRadius: 4,
              color:        theme === "dark" ? "#ccc" : "#222",
              fontSize:     11,
              padding:      "6px 8px",
              resize:       "vertical",
              boxSizing:    "border-box",
              fontFamily:   "inherit",
              outline:      "none",
              lineHeight:   1.5,
            }}
          />
          <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
            <button
              onClick={onEditSave}
              style={{
                ...MONO, height: 26, padding: "0 14px", fontSize: 10,
                background: "rgba(52,199,123,0.10)",
                border: "0.5px solid rgba(52,199,123,0.40)",
                color: GREEN, borderRadius: 4, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 5,
              }}
            >
              <i className="ti ti-check"
                style={{ fontSize: 13 }} aria-hidden="true" />
              Save
            </button>
            <button onClick={onEditCancel} style={ghostBtn(theme)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div style={{
          fontSize: 11, color: theme === "dark" ? "#bbb" : "#444",
          lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word",
        }}>
          {ann.note}
        </div>
      )}

      {/* Edit / Delete — diary and device only, not auto */}
      {!isEditing && ann.type !== "auto" && (
        <div style={{ display: "flex", gap: 5, marginTop: 7 }}
          onClick={e => e.stopPropagation()}>
          <button onClick={() => onEdit(ann)} style={ghostBtn(theme)}>
            <i className="ti ti-edit"
              style={{ fontSize: 13 }} aria-hidden="true" />
            Edit
          </button>
          <button
            onClick={() => onDelete(ann.id)}
            style={{
              ...ghostBtn(theme),
              borderColor: "rgba(192,57,43,0.35)",
              color:       "#c0392b",
            }}
          >
            <i className="ti ti-trash"
              style={{ fontSize: 13 }} aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Filter pill ──────────────────────────────────────────────────────────────
function FilterPill({ label, icon, active, count, onClick, theme }) {
  const col = active ? BLUE : MUTED;
  return (
    <button
      onClick={onClick}
      style={{
        ...MONO,
        height:       24,
        padding:      "0 10px",
        fontSize:     10,
        display:      "flex",
        alignItems:   "center",
        gap:          5,
        background:   active
          ? "rgba(55,138,221,0.10)" : "transparent",
        border:       `0.5px solid ${active
          ? "rgba(55,138,221,0.38)"
          : (theme === "dark" ? "#2a2a2a" : "#d4d4d4")}`,
        color:        col,
        borderRadius: 4,
        cursor:       "pointer",
        transition:   "all 0.1s",
        flexShrink:   0,
      }}
    >
      <i className={`ti ${icon}`}
        style={{ fontSize: 13 }} aria-hidden="true" />
      {label}
      {count > 0 && (
        <span style={{
          ...MONO, fontSize: 9,
          background:   theme === "dark" ? "#1e1e1e" : "#eee",
          borderRadius: 3, padding: "0 4px", color: col,
          lineHeight: "15px",
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function DiaryPanel({
  patientId,
  open,
  onClose,
  timeOffset = 0,
  onSeek,
  onMarkersChange,
  notify,
}) {
  const { theme, profile } = useApp();

  const [annotations,   setAnnotations]   = useState([]);
  const [filter,        setFilter]        = useState("all");
  const [loading,       setLoading]       = useState(false);
  const [newNote,       setNewNote]       = useState("");
  const [newTs,         setNewTs]         = useState("");
  const [editingId,     setEditingId]     = useState(null);
  const [editNote,      setEditNote]      = useState("");
  const [importing,     setImporting]     = useState(false);
  const [deviceEvtText, setDeviceEvtText] = useState("");
  const [showImport,    setShowImport]    = useState(false);
  const [expanded,      setExpanded]      = useState(false);
  // Session doctor — initialized from Facility profile but editable per-session.
  // Any doctor reviewing the ECG can type their name here; it signs that
  // session's notes without changing the global Settings profile.
  const [sessionDoctor,  setSessionDoctor]  = useState(() => profile?.doctor?.trim() || "");
  const [editingDoctor,  setEditingDoctor]  = useState(false);
  const [doctorDraft,    setDoctorDraft]    = useState("");

  // The name that gets written into annotation source field
  const doctorName = sessionDoctor.trim() || null;

  const bg       = theme === "dark" ? "#090909" : "#f7f7f7";
  const surface  = theme === "dark" ? "#0f0f0f" : "#fafafa";
  const borderC  = theme === "dark" ? "#1a1a1a" : "#e0e0e0";
  const text     = theme === "dark" ? "#bbb"    : "#333";
  const panelW   = expanded ? 620 : 360;

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchAll = useCallback(async () => {
    if (!patientId) return;
    setLoading(true);
    try {
      const res  = await fetch(`/api/annotations/${patientId}`);
      const data = await res.json();
      setAnnotations(Array.isArray(data) ? data : []);
    } catch (e) {
      notify?.({ type: "error", title: "Diary load failed", message: e.message });
    } finally {
      setLoading(false);
    }
  }, [patientId, notify]);

  useEffect(() => {
    if (open && patientId) fetchAll();
  }, [open, patientId, fetchAll]);

  // Push markers to TimelineBar
  useEffect(() => {
    const markers = annotations
      .filter(a => a.timestamp_sec != null)
      .map(a => ({
        timeSec: a.timestamp_sec,
        type:    "diary",
        label:   `[${a.type.toUpperCase()}] ${a.note.slice(0, 40)}`,
      }));
    onMarkersChange?.(markers);
  }, [annotations, onMarkersChange]);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  const handleCreate = useCallback(async () => {
    const note = newNote.trim();
    if (!note) return;
    const ts = newTs !== "" ? parseFloat(newTs) : null;
    // Source: physician name if available, else "doctor"
    const source = doctorName || "doctor";
    try {
      const res = await fetch(`/api/annotations/${patientId}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ note, timestamp_sec: ts,
          type: "diary", source }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const ann = await res.json();
      setAnnotations(prev =>
        [...prev, ann].sort(
          (a, b) => (a.timestamp_sec ?? 1e9) - (b.timestamp_sec ?? 1e9)
        )
      );
      setNewNote(""); setNewTs("");
      notify?.({ type: "success", title: "Note saved",
        message: note.slice(0, 60) });
    } catch (e) {
      notify?.({ type: "error", title: "Save failed", message: e.message });
    }
  }, [patientId, newNote, newTs, doctorName, notify]);

  const handleEditSave = useCallback(async () => {
    const note = editNote.trim();
    if (!note || !editingId) return;
    try {
      const res = await fetch(
        `/api/annotations/${patientId}/${editingId}`,
        { method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ note }) }
      );
      if (!res.ok) throw new Error((await res.json()).error);
      const updated = await res.json();
      setAnnotations(prev => prev.map(a => a.id === editingId ? updated : a));
      setEditingId(null); setEditNote("");
      notify?.({ type: "success", title: "Note updated" });
    } catch (e) {
      notify?.({ type: "error", title: "Update failed", message: e.message });
    }
  }, [patientId, editingId, editNote, notify]);

  const handleDelete = useCallback(async (annId) => {
    try {
      const res = await fetch(
        `/api/annotations/${patientId}/${annId}`,
        { method: "DELETE" }
      );
      if (!res.ok) throw new Error((await res.json()).error);
      setAnnotations(prev => prev.filter(a => a.id !== annId));
      notify?.({ type: "info", title: "Note deleted" });
    } catch (e) {
      notify?.({ type: "error", title: "Delete failed", message: e.message });
    }
  }, [patientId, notify]);

  const handleImport = useCallback(async () => {
    let events;
    try {
      events = JSON.parse(deviceEvtText);
      if (!Array.isArray(events)) throw new Error("Expected JSON array");
    } catch {
      notify?.({ type: "error", title: "Invalid JSON",
        message: 'Expected: [{"timestamp_sec":60,"note":"..."}]' });
      return;
    }
    setImporting(true);
    try {
      const res = await fetch(
        `/api/annotations/${patientId}/import-device-events`,
        { method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }) }
      );
      if (!res.ok) throw new Error((await res.json()).error);
      const { imported } = await res.json();
      notify?.({ type: "success", title: "Device events imported",
        message: `${imported} event(s) added` });
      setDeviceEvtText(""); setShowImport(false);
      fetchAll();
    } catch (e) {
      notify?.({ type: "error", title: "Import failed", message: e.message });
    } finally {
      setImporting(false);
    }
  }, [patientId, deviceEvtText, notify, fetchAll]);

  if (!open) return null;

  // ── Counts per type ───────────────────────────────────────────────────────
  const counts = {
    all:    annotations.length,
    diary:  annotations.filter(a => a.type === "diary").length,
    device: annotations.filter(a => a.type === "device").length,
    auto:   annotations.filter(a => a.type === "auto").length,
  };

  // Only show filter row if more than one type exists
  const hasMultipleTypes =
    [counts.diary, counts.device, counts.auto].filter(n => n > 0).length > 1;

  const filtered = filter === "all"
    ? annotations
    : annotations.filter(a => a.type === filter);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{
      position:      "absolute",
      top:           0,
      right:         0,
      bottom:        0,
      width:         panelW,
      display:       "flex",
      flexDirection: "column",
      zIndex:        100,
      background:    bg,
      color:         text,
      fontFamily:    "'IBM Plex Sans', 'Segoe UI', sans-serif",
      fontSize:      13,
      boxShadow:     theme === "dark"
        ? "-4px 0 24px rgba(0,0,0,0.55)"
        : "-4px 0 20px rgba(0,0,0,0.10)",
      transition:    "width 0.22s cubic-bezier(0.4,0,0.2,1)",
    }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{
        display:      "flex",
        alignItems:   "center",
        gap:          6,
        padding:      "0 12px",
        height:       38,
        borderBottom: `0.5px solid ${borderC}`,
        flexShrink:   0,
      }}>
        {/* Icon + title */}
        <i className="ti ti-notebook"
          style={{ fontSize: 15, color: BLUE, flexShrink: 0 }}
          aria-hidden="true" />
        <span style={{
          ...MONO,
          fontSize:      11,
          color:         theme === "dark" ? "#ccc" : "#555",
          letterSpacing: "0.09em",
          textTransform: "uppercase",
          flex:          1,
        }}>
          Patient diary
        </span>

        {/* Patient ID chip */}
        <span style={{
          ...MONO, fontSize: 9,
          color:        MUTED,
          background:   theme === "dark" ? "#141414" : "#f0f0f0",
          border:       `0.5px solid ${borderC}`,
          borderRadius: 3, padding: "2px 7px",
          flexShrink: 0,
        }}>
          {patientId}
        </span>

        {/* Count pills */}
        <span style={{
          ...MONO, fontSize: 9, color: GREEN,
          padding: "2px 7px",
          border: `0.5px solid ${GREEN}40`,
          background: `${GREEN}0e`,
          borderRadius: 3, flexShrink: 0,
        }}>
          {counts.diary} diary
        </span>

        {counts.device > 0 && (
          <span style={{
            ...MONO, fontSize: 9, color: BLUE,
            padding: "2px 7px",
            border: `0.5px solid ${BLUE}40`,
            background: `${BLUE}0e`,
            borderRadius: 3, flexShrink: 0,
          }}>
            {counts.device} device
          </span>
        )}

        {/* Divider */}
        <div style={{
          width: "0.5px", height: 14,
          background: borderC, flexShrink: 0,
        }} />

        {/* Physician name — inline editable, session-only override */}
        {editingDoctor ? (
          <div style={{
            display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
          }}>
            <i className="ti ti-user-edit"
              style={{ fontSize: 13, color: BLUE, flexShrink: 0 }}
              aria-hidden="true" />
            <input
              autoFocus
              value={doctorDraft}
              onChange={e => setDoctorDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  setSessionDoctor(doctorDraft);
                  setEditingDoctor(false);
                }
                if (e.key === "Escape") {
                  setEditingDoctor(false);
                }
              }}
              placeholder="Dr. Name"
              style={{
                ...MONO,
                width:        110,
                height:       22,
                fontSize:     10,
                padding:      "0 7px",
                background:   theme === "dark" ? "#111" : "#f5f5f5",
                border:       `0.5px solid ${BLUE}`,
                borderRadius: 3,
                color:        theme === "dark" ? "#ccc" : "#222",
                outline:      "none",
              }}
            />
            {/* Confirm */}
            <button
              onClick={() => { setSessionDoctor(doctorDraft); setEditingDoctor(false); }}
              title="Confirm name"
              style={{
                width: 22, height: 22, padding: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "rgba(52,199,123,0.10)",
                border: "0.5px solid rgba(52,199,123,0.40)",
                color: GREEN, borderRadius: 3, cursor: "pointer", flexShrink: 0,
              }}
            >
              <i className="ti ti-check"
                style={{ fontSize: 12, pointerEvents: "none" }} aria-hidden="true" />
            </button>
            {/* Cancel */}
            <button
              onClick={() => setEditingDoctor(false)}
              title="Cancel"
              style={{
                width: 22, height: 22, padding: 0,
                display: "flex", alignItems: "center", justifyContent: "center",
                background: "transparent",
                border: `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
                color: MUTED, borderRadius: 3, cursor: "pointer", flexShrink: 0,
              }}
            >
              <i className="ti ti-x"
                style={{ fontSize: 12, pointerEvents: "none" }} aria-hidden="true" />
            </button>
          </div>
        ) : (
          /* Display mode — click to edit */
          <button
            onClick={() => { setDoctorDraft(sessionDoctor); setEditingDoctor(true); }}
            title="Click to change reviewing physician for this session"
            style={{
              ...MONO,
              display:     "flex",
              alignItems:  "center",
              gap:         4,
              fontSize:    9,
              color:       doctorName ? MUTED : "#555",
              background:  "transparent",
              border:      "none",
              cursor:      "pointer",
              flexShrink:  0,
              padding:     0,
              fontStyle:   doctorName ? "normal" : "italic",
            }}
          >
            <i
              className={`ti ${doctorName ? "ti-user-circle" : "ti-user-question"}`}
              style={{ fontSize: 13 }}
              aria-hidden="true"
            />
            {doctorName || "Set physician"}
            <i className="ti ti-pencil"
              style={{ fontSize: 10, opacity: 0.4 }} aria-hidden="true" />
          </button>
        )}

        <div style={{
          width: "0.5px", height: 14,
          background: borderC, flexShrink: 0,
        }} />

        {/* Expand / compress */}
        <HeaderIconBtn
          icon={expanded ? "ti-arrows-minimize" : "ti-arrows-maximize"}
          onClick={() => setExpanded(v => !v)}
          title={expanded ? "Compress panel" : "Expand panel"}
          theme={theme}
        />

        {/* Close */}
        <HeaderIconBtn
          icon="ti-x"
          onClick={onClose}
          title="Close diary"
          theme={theme}
          danger
        />
      </div>

      {/* ── Filter pills — only shown when multiple annotation types exist ── */}
      {hasMultipleTypes && (
        <div style={{
          display:      "flex",
          alignItems:   "center",
          gap:          5,
          padding:      "6px 12px",
          borderBottom: `0.5px solid ${borderC}`,
          flexShrink:   0,
          flexWrap:     "wrap",
        }}>
          <FilterPill
            label="All" icon="ti-list"
            active={filter === "all"} count={counts.all}
            onClick={() => setFilter("all")} theme={theme}
          />
          {counts.diary > 0 && (
            <FilterPill
              label="Doctor" icon="ti-stethoscope"
              active={filter === "diary"} count={counts.diary}
              onClick={() => setFilter("diary")} theme={theme}
            />
          )}
          {counts.device > 0 && (
            <FilterPill
              label="Device" icon="ti-device-heart-monitor"
              active={filter === "device"} count={counts.device}
              onClick={() => setFilter("device")} theme={theme}
            />
          )}
          {counts.auto > 0 && (
            <FilterPill
              label="Auto" icon="ti-robot"
              active={filter === "auto"} count={counts.auto}
              onClick={() => setFilter("auto")} theme={theme}
            />
          )}
        </div>
      )}

      {/* ── Annotation list ───────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px" }}>
        {loading && (
          <p style={{ ...MONO, fontSize: 10, color: MUTED, marginTop: 8 }}>
            Loading…
          </p>
        )}

        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: "center", marginTop: 48 }}>
            <i className="ti ti-notes-off"
              style={{ fontSize: 30, color: borderC,
                display: "block", marginBottom: 12 }}
              aria-hidden="true" />
            <p style={{ ...MONO, fontSize: 10, color: MUTED, lineHeight: 1.9 }}>
              No diary entries yet.<br />
              {!doctorName && (
                <>
                  <span style={{ color: "#444" }}>
                    Tip: set physician name in Settings → Facility
                  </span>
                  <br />
                </>
              )}
              Add a note below.
            </p>
          </div>
        )}

        {filtered.map(ann => (
          <AnnotationRow
            key={ann.id}
            ann={ann}
            doctorName={doctorName}
            onSeek={onSeek}
            onEdit={a => { setEditingId(a.id); setEditNote(a.note); }}
            onDelete={handleDelete}
            isEditing={editingId === ann.id}
            editNote={editNote}
            onEditNoteChange={setEditNote}
            onEditSave={handleEditSave}
            onEditCancel={() => { setEditingId(null); setEditNote(""); }}
            theme={theme}
          />
        ))}
      </div>

      {/* ── Add note form ─────────────────────────────────────────────────── */}
      <div style={{
        padding:      "10px 14px",
        borderTop:    `0.5px solid ${borderC}`,
        background:   surface,
        flexShrink:   0,
      }}>

        {/* Timestamp row */}
        <div style={{
          display:      "flex",
          alignItems:   "center",
          gap:          8,
          marginBottom: 8,
        }}>
          <label style={{ ...MONO, fontSize: 9, color: MUTED,
            letterSpacing: "0.07em", textTransform: "uppercase",
            flexShrink: 0 }}>
            Timestamp
          </label>
          <input
            type="number"
            placeholder={timeOffset.toFixed(1)}
            value={newTs}
            onChange={e => setNewTs(e.target.value)}
            step="0.1"
            style={{
              ...inputSt(theme),
              width:      82,
              color:      BLUE,
              fontFamily: "'Share Tech Mono','Consolas',monospace",
              fontSize:   11,
            }}
          />
          <button
            onClick={() => setNewTs(timeOffset.toFixed(1))}
            title="Stamp current playback position"
            style={primaryBtn(theme)}
          >
            <i className="ti ti-player-play"
              style={{ fontSize: 13 }} aria-hidden="true" />
            Now
          </button>
          {newTs && (
            <span style={{ ...MONO, fontSize: 9, color: MUTED }}>
              {fmtHMS(parseFloat(newTs))}
            </span>
          )}
        </div>

        {/* Note textarea */}
        <textarea
          value={newNote}
          onChange={e => setNewNote(e.target.value)}
          onFocus={e => {
            if (!newTs) setNewTs(timeOffset.toFixed(1));
            e.target.style.borderColor = BLUE;
          }}
          onBlur={e => {
            e.target.style.borderColor =
              theme === "dark" ? "#2a2a2a" : "#d4d4d4";
          }}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) handleCreate();
          }}
          placeholder={
            doctorName
              ? `Note by ${doctorName}… (Ctrl+Enter to save)`
              : "Add diary note… (Ctrl+Enter to save)"
          }
          rows={3}
          style={{
            width:        "100%",
            background:   theme === "dark" ? "#111" : "#f5f5f5",
            border:       `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
            borderRadius: 4,
            color:        theme === "dark" ? "#ccc" : "#222",
            fontSize:     11,
            padding:      "7px 9px",
            resize:       "vertical",
            boxSizing:    "border-box",
            fontFamily:   "inherit",
            lineHeight:   1.55,
            outline:      "none",
          }}
        />

        {/* Save + Import */}
        <div style={{ display: "flex", gap: 7, marginTop: 8 }}>
          <button
            onClick={handleCreate}
            disabled={!newNote.trim()}
            style={{
              ...MONO,
              flex:           1,
              height:         30,
              fontSize:       11,
              letterSpacing:  "0.04em",
              background:     newNote.trim()
                ? "rgba(52,199,123,0.10)" : "transparent",
              border:         `0.5px solid ${newNote.trim()
                ? "rgba(52,199,123,0.40)"
                : (theme === "dark" ? "#2a2a2a" : "#d4d4d4")}`,
              color:          newNote.trim() ? GREEN : MUTED,
              borderRadius:   4,
              cursor:         newNote.trim() ? "pointer" : "not-allowed",
              display:        "flex",
              alignItems:     "center",
              justifyContent: "center",
              gap:            6,
            }}
          >
            <i className="ti ti-plus"
              style={{ fontSize: 14 }} aria-hidden="true" />
            Save note
          </button>

          <button
            onClick={() => setShowImport(v => !v)}
            style={{
              ...ghostBtn(theme),
              height: 30,
              ...(showImport && {
                borderColor: "rgba(55,138,221,0.40)",
                background:  "rgba(55,138,221,0.07)",
                color:       BLUE,
              }),
            }}
          >
            <i className="ti ti-upload"
              style={{ fontSize: 13 }} aria-hidden="true" />
            Import
          </button>
        </div>

        {/* Device JSON import area */}
        {showImport && (
          <div style={{
            marginTop:    9,
            padding:      "10px 12px",
            background:   theme === "dark" ? "#0a0a0a" : "#f0f4fa",
            border:       `0.5px solid ${theme === "dark"
              ? "rgba(55,138,221,0.14)" : "rgba(55,138,221,0.22)"}`,
            borderRadius: 5,
          }}>
            <div style={{
              ...MONO, fontSize: 9, color: MUTED,
              letterSpacing: "0.08em", textTransform: "uppercase",
              marginBottom: 6,
            }}>
              Paste device events JSON
            </div>
            <textarea
              value={deviceEvtText}
              onChange={e => setDeviceEvtText(e.target.value)}
              placeholder={'[{"timestamp_sec":120,"note":"Patient felt palpitations"},...]'}
              rows={3}
              style={{
                width:        "100%",
                background:   theme === "dark" ? "#080808" : "#eef4fc",
                border:       `0.5px solid ${theme === "dark"
                  ? "rgba(55,138,221,0.18)" : "rgba(55,138,221,0.25)"}`,
                borderRadius: 3,
                color:        BLUE,
                fontSize:     10,
                padding:      "6px 8px",
                resize:       "vertical",
                boxSizing:    "border-box",
                fontFamily:   "'Share Tech Mono','Consolas',monospace",
                lineHeight:   1.6,
                outline:      "none",
              }}
            />
            <button
              onClick={handleImport}
              disabled={importing || !deviceEvtText.trim()}
              style={{
                ...MONO,
                marginTop:      6, width: "100%", height: 28,
                fontSize:       10, letterSpacing: "0.04em",
                background:     "rgba(55,138,221,0.09)",
                border:         "0.5px solid rgba(55,138,221,0.35)",
                color:          importing || !deviceEvtText.trim() ? MUTED : BLUE,
                borderRadius:   4,
                cursor:         importing || !deviceEvtText.trim()
                  ? "not-allowed" : "pointer",
                opacity:        importing ? 0.6 : 1,
                display:        "flex", alignItems: "center",
                justifyContent: "center", gap: 7,
              }}
            >
              <i className="ti ti-upload"
                style={{ fontSize: 13 }} aria-hidden="true" />
              {importing ? "Importing…" : "Import device events"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
/**
 * RecordsPage.jsx
 * Patient ECG records — sortable, searchable, inline-edit.
 *
 * Design system:
 *   All colours are CSS custom properties defined in RECORDS_STYLES.
 *   Theme is driven by data-theme="dark"|"light" on <html>.
 *   The parent app should call initRecordsTheme() on mount to apply
 *   the persisted preference.
 *
 * Requires: lucide-react
 *
 * v2 changes:
 *  - Removed beat-type legend row
 *  - Removed SR column
 *  - Merged 3-Lead / 12-Lead into a single "Lead Type" column
 *  - Renamed "Recorded" -> "Data Received"
 *  - Added "Recording Period" column (left of Data Received) showing the
 *    patient's recording start -> end span, derived from created_at + duration
 *  - Edit / Delete actions are now icon-only
 *  - Removed Import EDF action entirely
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  Activity,
  Wifi,
  Bluetooth,
  Usb,
  MemoryStick,
  Pencil,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Search,
  Check,
  X,
  Loader2,
  MonitorCheck,
  Trash2,
  AlertTriangle,
} from "lucide-react";

// ─── Design-system stylesheet ─────────────────────────────────────────────────
// Every colour reference in JSX must come from one of these variables.
// Dark theme is default; light theme overrides the same variables.

const RECORDS_STYLES = `
  /* ── Tokens ─────────────────────────────────────────────────────────────
     All --rec-* custom properties are supplied at runtime via inline style
     on .rec-root, derived from the app's tokens object (AppContext THEMES).
     See buildRecVars() below.
  ── ───────────────────────────────────────────────────────────────────── */

  /* ── Base ───────────────────────────────────────────────────────────────── */
  .rec-root {
    flex: 1;
    overflow: auto;
    background: var(--rec-surface-0);
    padding: 24px 28px;
    font-family: "Inter", "Segoe UI", system-ui, sans-serif;
    color: var(--rec-text-primary);
    scrollbar-width: thin;
    scrollbar-color: var(--rec-scrollbar-thumb) var(--rec-scrollbar-track);
  }
  .rec-root::-webkit-scrollbar       { width: 6px; }
  .rec-root::-webkit-scrollbar-track { background: var(--rec-scrollbar-track); }
  .rec-root::-webkit-scrollbar-thumb { background: var(--rec-scrollbar-thumb); border-radius: 3px; }

  /* ── Header ─────────────────────────────────────────────────────────────── */
  .rec-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 20px;
    gap: 16px;
    flex-wrap: wrap;
  }
  .rec-header__title {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--rec-text-primary);
  }
  .rec-header__title-icon {
    color: var(--rec-accent);
  }
  .rec-header__count {
    font-size: 11px;
    font-weight: 400;
    color: var(--rec-text-secondary);
    margin-top: 4px;
    letter-spacing: 0;
    text-transform: none;
    font-family: "JetBrains Mono", "Fira Code", "Consolas", monospace;
  }
  .rec-header__controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  /* ── Search ──────────────────────────────────────────────────────────────── */
  .rec-search {
    position: relative;
  }
  .rec-search__icon {
    position: absolute;
    left: 10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--rec-text-dim);
    pointer-events: none;
  }
  .rec-search__input {
    background: var(--rec-surface-1);
    border: 1px solid var(--rec-border);
    border-radius: 6px;
    padding: 7px 12px 7px 32px;
    font-size: 12px;
    font-family: inherit;
    color: var(--rec-text-primary);
    outline: none;
    width: 220px;
    transition: border-color 0.15s;
  }
  .rec-search__input::placeholder { color: var(--rec-text-dim); }
  .rec-search__input:focus { border-color: var(--rec-border-focus); }

  /* ── Source badges ───────────────────────────────────────────────────────── */
  .rec-source-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px 2px 5px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    font-family: "JetBrains Mono", monospace;
    letter-spacing: 0.03em;
    white-space: nowrap;
  }
  .rec-source-badge--wifi     { background: var(--rec-accent-dim);   color: var(--rec-accent);   border: 1px solid var(--rec-accent-mid);  }
  .rec-source-badge--bt       { background: var(--rec-purple-dim);   color: var(--rec-purple);   border: 1px solid rgba(124,111,205,0.3); }
  .rec-source-badge--usb      { background: var(--rec-success-dim);  color: var(--rec-success);  border: 1px solid rgba(46,173,106,0.3);  }
  .rec-source-badge--sd       { background: var(--rec-warning-dim);  color: var(--rec-warning);  border: 1px solid rgba(212,134,11,0.3);  }
  .rec-source-badge--none     { background: transparent;             color: var(--rec-text-dim); border: 1px solid var(--rec-border);     }

  /* ── Duration / lead-type badge ──────────────────────────────────────────── */
  .rec-dur-badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-family: "JetBrains Mono", monospace;
    font-weight: 500;
    white-space: nowrap;
  }
  .rec-dur-badge--3lead  { background: var(--rec-success-dim); color: var(--rec-success);  border: 1px solid rgba(46,173,106,0.3); }
  .rec-dur-badge--12lead { background: var(--rec-accent-dim);  color: var(--rec-accent);   border: 1px solid var(--rec-accent-mid); }
  .rec-dur-badge--none   { color: var(--rec-text-dim); font-size: 11px; }

  /* ── Recording period badge ──────────────────────────────────────────────── */
  .rec-period-badge {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    color: var(--rec-text-secondary);
    white-space: nowrap;
  }
  .rec-period-badge__arrow {
    color: var(--rec-text-dim);
    margin: 0 4px;
  }

  /* ── Table ───────────────────────────────────────────────────────────────── */
  .rec-table-wrap {
    border: 1px solid var(--rec-border);
    border-radius: 8px;
    overflow: hidden;
  }
  .rec-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  .rec-table thead {
    background: var(--rec-surface-1);
  }
  .rec-table th {
    padding: 10px 14px;
    text-align: left;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--rec-text-secondary);
    border-bottom: 1px solid var(--rec-border);
    white-space: nowrap;
    font-family: "JetBrains Mono", monospace;
    user-select: none;
  }
  .rec-table th.sortable {
    cursor: pointer;
  }
  .rec-table th.sortable:hover {
    color: var(--rec-text-primary);
  }
  .rec-table th.sort-active {
    color: var(--rec-accent);
  }
  .rec-th-inner {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .rec-table tbody tr {
    background: var(--rec-surface-0);
    border-bottom: 1px solid var(--rec-border);
    transition: background 0.1s;
  }
  .rec-table tbody tr:nth-child(even) {
    background: var(--rec-surface-1);
  }
  .rec-table tbody tr:last-child {
    border-bottom: none;
  }
  .rec-table tbody tr:hover {
    background: var(--rec-surface-hover);
  }
  .rec-table td {
    padding: 11px 14px;
    vertical-align: middle;
  }

  /* ── Cell types ──────────────────────────────────────────────────────────── */
  .rec-cell-id {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    font-weight: 600;
    color: var(--rec-accent);
    white-space: nowrap;
  }
  .rec-cell-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--rec-text-primary);
  }
  .rec-cell-mono {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    color: var(--rec-text-secondary);
    white-space: nowrap;
  }
  .rec-cell-dim {
    font-family: "JetBrains Mono", monospace;
    font-size: 11px;
    color: var(--rec-text-dim);
  }

  /* ── Action buttons ──────────────────────────────────────────────────────── */
  .rec-actions {
    display: flex;
    gap: 5px;
    flex-wrap: nowrap;
    align-items: center;
  }
  .rec-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 5px 10px;
    border-radius: 5px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap;
    outline: none;
  }
  .rec-btn:focus-visible {
    box-shadow: 0 0 0 2px var(--rec-border-focus);
  }
  .rec-btn--icon {
    padding: 6px;
    gap: 0;
  }
  .rec-btn--primary {
    background: var(--rec-accent-dim);
    border-color: var(--rec-accent-mid);
    color: var(--rec-accent);
  }
  .rec-btn--primary:hover {
    background: rgba(45,125,210,0.22);
  }
  .rec-btn--warning {
    background: var(--rec-warning-dim);
    border-color: rgba(212,134,11,0.3);
    color: var(--rec-warning);
  }
  .rec-btn--warning:hover {
    background: rgba(212,134,11,0.2);
  }
  .rec-btn--success {
    background: var(--rec-success-dim);
    border-color: rgba(46,173,106,0.3);
    color: var(--rec-success);
  }
  .rec-btn--success:hover {
    background: rgba(46,173,106,0.2);
  }
  .rec-btn--danger {
    background: var(--rec-error-dim);
    border-color: rgba(217,76,76,0.3);
    color: var(--rec-error);
  }
  .rec-btn--danger:hover {
    background: rgba(217,76,76,0.2);
  }
  .rec-btn--ghost {
    background: transparent;
    border-color: var(--rec-border);
    color: var(--rec-text-secondary);
  }
  .rec-btn--ghost:hover {
    background: var(--rec-surface-2);
    color: var(--rec-text-primary);
  }
  .rec-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ── Inline edit row ─────────────────────────────────────────────────────── */
  .rec-edit-row td {
    background: var(--rec-surface-2) !important;
    border-bottom: 1px solid var(--rec-border-strong) !important;
  }
  .rec-edit-row td:first-child {
    border-left: 3px solid var(--rec-accent);
  }
  .rec-input {
    background: var(--rec-surface-0);
    border: 1px solid var(--rec-border-strong);
    border-radius: 5px;
    padding: 5px 8px;
    font-size: 11px;
    font-family: "JetBrains Mono", monospace;
    color: var(--rec-text-primary);
    outline: none;
    width: 100%;
    transition: border-color 0.15s;
  }
  .rec-input:focus { border-color: var(--rec-border-focus); }
  .rec-select {
    background: var(--rec-surface-0);
    border: 1px solid var(--rec-border-strong);
    border-radius: 5px;
    padding: 5px 6px;
    font-size: 11px;
    font-family: "JetBrains Mono", monospace;
    color: var(--rec-text-primary);
    outline: none;
    width: 58px;
    cursor: pointer;
    transition: border-color 0.15s;
  }
  .rec-select:focus { border-color: var(--rec-border-focus); }
  .rec-edit-error {
    font-size: 10px;
    font-family: "JetBrains Mono", monospace;
    color: var(--rec-error);
    margin-bottom: 4px;
  }

  /* ── Delete confirm row ──────────────────────────────────────────────────── */
  .rec-delete-confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--rec-error);
    font-family: "JetBrains Mono", monospace;
    white-space: nowrap;
  }
  .rec-delete-confirm__icon {
    flex-shrink: 0;
  }

  /* ── Empty state ─────────────────────────────────────────────────────────── */
  .rec-empty {
    padding: 48px 16px;
    text-align: center;
    color: var(--rec-text-dim);
    font-size: 12px;
    font-family: "JetBrains Mono", monospace;
    letter-spacing: 0.05em;
  }

  /* ── Spin animation ──────────────────────────────────────────────────────── */
  @keyframes rec-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  .rec-spin { animation: rec-spin 0.8s linear infinite; }

  @media (prefers-reduced-motion: reduce) {
    .rec-spin { animation: none; }
    .rec-table tbody tr { transition: none; }
    .rec-btn { transition: none; }
  }
`;

// ─── Constants ────────────────────────────────────────────────────────────────

const SOURCE_CONFIG = {
  wifi: { Icon: Wifi,      label: "Wi-Fi",    cls: "rec-source-badge--wifi" },
  bt:   { Icon: Bluetooth, label: "BT",       cls: "rec-source-badge--bt"   },
  usb:  { Icon: Usb,       label: "USB",      cls: "rec-source-badge--usb"  },
  sd:   { Icon: MemoryStick, label: "SD Card", cls: "rec-source-badge--sd"   },
};

// Aliases so values like "USB Cable", "usb-import", "sd_card", "bluetooth", etc.
// from the API still map onto a known badge instead of falling through.
const SOURCE_ALIASES = {
  wifi:      "wifi",
  "wi-fi":   "wifi",
  bluetooth: "bt",
  bt:        "bt",
  usb:       "usb",
  "usb cable": "usb",
  "usb-cable": "usb",
  sd:        "sd",
  sdcard:    "sd",
  "sd card": "sd",
  "sd-card": "sd",
};

function resolveSourceKey(source) {
  if (!source) return null;
  const key = String(source).trim().toLowerCase();
  return SOURCE_ALIASES[key] ?? (SOURCE_CONFIG[key] ? key : null);
}

// ─── Theme bridge ─────────────────────────────────────────────────────────────
// Maps the app's `tokens` object (from AppContext THEMES) onto this page's
// --rec-* CSS custom properties. Any token without a direct equivalent is
// derived via withAlpha() — same approach the rest of the app uses inline
// (e.g. "rgba(79,142,247,0.1)").

function withAlpha(hex, alpha) {
  if (!hex) return `rgba(0,0,0,${alpha})`;
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function buildRecVars(tokens, theme) {
  const dimAlpha = theme === "light" ? 0.08 : 0.12;
  const midAlpha = theme === "light" ? 0.18 : 0.22;

  return {
    "--rec-surface-0":      tokens.bg,
    "--rec-surface-1":      tokens.surface,
    "--rec-surface-2":      tokens.surface2,
    "--rec-surface-hover":  withAlpha(tokens.accent, theme === "light" ? 0.06 : 0.08),

    "--rec-border":         tokens.border,
    "--rec-border-strong":  tokens.border2,
    "--rec-border-focus":   tokens.accent,

    "--rec-accent":         tokens.accent,
    "--rec-accent-dim":     withAlpha(tokens.accent, dimAlpha),
    "--rec-accent-mid":     withAlpha(tokens.accent, midAlpha),

    "--rec-success":        tokens.accentGreen,
    "--rec-success-dim":    withAlpha(tokens.accentGreen, dimAlpha),
    "--rec-warning":        tokens.accentAmber,
    "--rec-warning-dim":    withAlpha(tokens.accentAmber, dimAlpha),
    "--rec-error":          tokens.accentRed,
    "--rec-error-dim":      withAlpha(tokens.accentRed, dimAlpha),
    "--rec-purple":         theme === "light" ? "#5C51B0" : "#7C6FCD",
    "--rec-purple-dim":     withAlpha(theme === "light" ? "#5C51B0" : "#7C6FCD", dimAlpha),

    "--rec-text-primary":   tokens.textPrimary,
    "--rec-text-secondary": tokens.textSecondary,
    "--rec-text-dim":       tokens.textMuted,
    "--rec-text-inverse":   theme === "light" ? "#FFFFFF" : "#0A0C0F",

    "--rec-scrollbar-thumb": tokens.border,
    "--rec-scrollbar-track": tokens.bg,
  };
}

function useInjectStyles(id, css) {
  useEffect(() => {
    if (document.getElementById(id)) return;
    const el = document.createElement("style");
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
    return () => el.remove();
  }, [id, css]);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDur(hr) {
  if (hr == null) return null;
  const h = Math.floor(hr);
  const m = Math.round((hr - h) * 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

// Date-only formatter used by the recording-period column, e.g. "11 Jun".
function fmtShortDate(d) {
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

// Builds the patient's recording span (start -> end) from created_at + the
// duration of whichever lead file is present. Most Holter recordings run
// ~48h, so the end date is very often a day or two after the start date —
// shown as a from/to range rather than a single date.
function getRecordingPeriod(p) {
  if (!p.created_at) return null;
  const start = new Date(`${p.created_at}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;

  const durHr = p.dur12 ?? p.dur3;
  if (durHr == null) return { start, end: null };

  const end = new Date(start.getTime() + durHr * 3600 * 1000);
  return { start, end };
}

function RecordingPeriodBadge({ patient }) {
  const period = getRecordingPeriod(patient);
  if (!period) return <span className="rec-cell-dim">—</span>;

  const { start, end } = period;
  if (!end || start.toDateString() === end.toDateString()) {
    return <span className="rec-period-badge">{fmtShortDate(start)}</span>;
  }

  return (
    <span className="rec-period-badge">
      {fmtShortDate(start)}
      <span className="rec-period-badge__arrow">&rarr;</span>
      {fmtShortDate(end)}
    </span>
  );
}

function SourceBadge({ source }) {
  const key = resolveSourceKey(source);
  const cfg = key ? SOURCE_CONFIG[key] : null;
  if (!cfg) return <span className="rec-cell-dim">—</span>;
  const { Icon, label, cls } = cfg;
  return (
    <span className={`rec-source-badge ${cls}`}>
      <Icon size={10} strokeWidth={2} />
      {label}
    </span>
  );
}

function DurBadge({ dur, variant, label }) {
  const text = fmtDur(dur);
  if (!text) return <span className="rec-dur-badge rec-dur-badge--none">—</span>;
  return (
    <span className={`rec-dur-badge rec-dur-badge--${variant}`}>
      {label ? `${label} · ` : ""}{text}
    </span>
  );
}

// Single merged "Lead Type" column — shows whichever lead file is present
// (12-lead is preferred when a patient happens to have both on record).
function LeadTypeBadge({ patient }) {
  if (patient.has12) return <DurBadge dur={patient.dur12} variant="12lead" label="12L" />;
  if (patient.has3)  return <DurBadge dur={patient.dur3}  variant="3lead"  label="3L"  />;
  return <span className="rec-cell-dim">—</span>;
}

// ─── Inline edit row ──────────────────────────────────────────────────────────

function EditRow({ patient, onSave, onCancel }) {
  const [form, setForm] = useState({
    name:       patient.name       ?? "",
    age:        patient.age        ?? "",
    sex:        patient.sex        ?? "M",
    dob:        patient.dob        ?? "",
    created_at: patient.created_at ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState("");
  const firstInputRef = useRef(null);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/patients/${patient.id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(form),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      onSave(updated);
    } catch (e) {
      setError(e.message);
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter")  save();
    if (e.key === "Escape") onCancel();
  };

  return (
    <tr className="rec-edit-row" onKeyDown={handleKeyDown}>
      <td><span className="rec-cell-id">{patient.id}</span></td>

      <td>
        <input
          ref={firstInputRef}
          className="rec-input"
          value={form.name}
          onChange={set("name")}
          id={`edit-name-${patient.id}`}
          name="name"
          placeholder="Patient name"
        />
      </td>

      <td>
        <input
          className="rec-input"
          style={{ width: 52 }}
          id={`edit-age-${patient.id}`}
          name="age"
          type="number"
          min={0}
          max={130}
          value={form.age}
          onChange={set("age")}
        />
      </td>

      <td>
        <select id={`edit-sex-${patient.id}`}
          name="sex"
          className="rec-select" value={form.sex} onChange={set("sex")}>
          <option value="M">M</option>
          <option value="F">F</option>
          <option value="O">O</option>
        </select>
      </td>

      <td>
        <input
          className="rec-input"
          style={{ width: 104 }}
          id={`edit-dob-${patient.id}`}
          name="dob"
          value={form.dob}
          onChange={set("dob")}
          placeholder="YYYY-MM-DD"
        />
      </td>

      {/* Recording Period — derived, not editable here */}
      <td />

      <td>
        <input
          className="rec-input"
          style={{ width: 104 }}
          id={`edit-created-${patient.id}`}
          name="created_at"
          value={form.created_at}
          onChange={set("created_at")}
          placeholder="YYYY-MM-DD"
        />
      </td>

      {/* Source — not editable here */}
      <td />
      {/* Lead Type — not editable here */}
      <td />

      <td>
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {error && <div className="rec-edit-error">{error}</div>}
          <div style={{ display: "flex", gap: 5 }}>
            <button
              className="rec-btn rec-btn--success"
              onClick={save}
              disabled={saving}
              aria-label="Save changes"
            >
              {saving
                ? <Loader2 size={12} className="rec-spin" />
                : <Check size={12} strokeWidth={2.5} />}
              {saving ? "Saving" : "Save"}
            </button>
            <button
              className="rec-btn rec-btn--ghost"
              onClick={onCancel}
              aria-label="Cancel edit"
            >
              <X size={12} strokeWidth={2.5} />
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ─── Sort header cell ─────────────────────────────────────────────────────────

function TH({ sortKey, label, sort, onSort }) {
  const active = sort.key === sortKey;
  const Icon = active
    ? sort.dir > 0 ? ChevronUp : ChevronDown
    : ChevronsUpDown;
  return (
    <th
      className={`sortable${active ? " sort-active" : ""}`}
      onClick={() => onSort(sortKey)}
      aria-sort={active ? (sort.dir > 0 ? "ascending" : "descending") : "none"}
    >
      <span className="rec-th-inner">
        {label}
        <Icon size={11} strokeWidth={2} />
      </span>
    </th>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

const TOTAL_COLS = 10; // ID, Name, Age, Sex, DOB, Recording Period, Data Received, Source, Lead Type, Actions

export default function RecordsPage({ patients: initialPatients, h5Files, onOpenPatient, tokens, theme }) {
  useInjectStyles("rec-system-styles", RECORDS_STYLES);

  const recVars = useMemo(() => buildRecVars(tokens, theme), [tokens, theme]);

  const [patients, setPatients] = useState(initialPatients);
  const [sort,     setSort]     = useState({ key: "id", dir: 1 });
  const [search,   setSearch]   = useState("");
  const [editId,   setEditId]   = useState(null);

  // Delete state
  const [deleteId,    setDeleteId]    = useState(null); // row pending confirmation
  const [deletingId,  setDeletingId]  = useState(null); // row currently being deleted
  const [deleteError, setDeleteError] = useState(null); // { id, message }

  useEffect(() => {
    setPatients(initialPatients);
  }, [initialPatients]);

  const toggleSort = useCallback((key) => {
    setSort((s) => ({ key, dir: s.key === key ? -s.dir : 1 }));
  }, []);

  // Normalize a file path to its trailing relative portion so that
  // absolute paths (C:\...\data\patients\P001\ecg.h5) and relative
  // paths (data\patients\P001\ecg.h5) resolve to the same key.
  const normalizePath = (p) => {
  if (!p) return "";
  const s = p.split("\\").join("/");
  const markers = ["data/patients/", "patients/"];
  for (const m of markers) {
    const idx = s.lastIndexOf(m);
    if (idx !== -1) return s.slice(idx);
  }
  return s.split("/").pop();
};

  const enriched = patients.map((p) => {
    const norm3  = normalizePath(p.h5_3lead);
    const norm12 = normalizePath(p.h5_12lead);
    const f3  = norm3  ? h5Files?.find((f) => normalizePath(f.filename) === norm3)  : null;
    const f12 = norm12 ? h5Files?.find((f) => normalizePath(f.filename) === norm12) : null;
    // Prefer n_leads field to distinguish 3-lead vs 12-lead
    const file3  = f3?.n_leads  <= 3  ? f3  : null;
    const file12 = f12?.n_leads >= 12 ? f12 : null;
    // Also check if either matched file is the other type (swap if needed)
    const resolved3  = file3  ?? (f3?.n_leads  >= 12 ? null : f3);
    const resolved12 = file12 ?? (f12?.n_leads <= 3  ? null : f12);
    // Prefer the source recorded against the actual data file (set at
    // import/acquisition time, e.g. "usb" for an EDF import) over the
    // patient-level `source` field, which may be stale or default to "wifi".
    const fileSource = resolved3?.source ?? resolved12?.source ?? f3?.source ?? f12?.source;
    return {
      ...p,
      dur3:   resolved3?.duration_hr,
      dur12:  resolved12?.duration_hr,
      sr:     resolved3?.sr ?? resolved12?.sr ?? 250,
      has3:   !!resolved3,
      has12:  !!resolved12,
      source: fileSource ?? p.source,
    };
  });

  const rows = enriched
    .filter((p) => {
      if (!search) return true;
      const q = search.toLowerCase();
      return p.name?.toLowerCase().includes(q) || p.id?.toLowerCase().includes(q);
    })
    .sort((a, b) => {
      const av = a[sort.key] ?? "";
      const bv = b[sort.key] ?? "";
      return sort.dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });

  const handleSave = useCallback((updated) => {
    setPatients((prev) =>
      prev.map((p) => (p.id === updated.id ? { ...p, ...updated } : p))
    );
    setEditId(null);
  }, []);

  const handleDelete = useCallback(async (patientId) => {
    setDeletingId(patientId);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/patients/${patientId}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPatients((prev) => prev.filter((p) => p.id !== patientId));
      setDeleteId(null);
    } catch (err) {
      setDeleteError({ id: patientId, message: err.message });
    } finally {
      setDeletingId(null);
    }
  }, []);

  return (
    <div className="rec-root" style={recVars}>

      {/* ── Header ── */}
      <div className="rec-header">
        <div>
          <div className="rec-header__title">
            <Activity size={15} strokeWidth={2} className="rec-header__title-icon" />
            Patient Records
          </div>
          <div className="rec-header__count">
            {rows.length} of {patients.length} records
          </div>
        </div>

        <div className="rec-header__controls">
          <div className="rec-search">
            <Search size={13} className="rec-search__icon" />
            <input
              id="rec-patient-search" name="search" className="rec-search__input"
              placeholder="Search by name or ID"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search patients"
            />
          </div>
        </div>
      </div>

      {/* ── Table ── */}
      <div className="rec-table-wrap">
        <table className="rec-table" role="grid" aria-label="Patient records">
          <thead>
            <tr>
              <TH sortKey="id"         label="ID"               sort={sort} onSort={toggleSort} />
              <TH sortKey="name"       label="Name"             sort={sort} onSort={toggleSort} />
              <TH sortKey="age"        label="Age"              sort={sort} onSort={toggleSort} />
              <TH sortKey="sex"        label="Sex"              sort={sort} onSort={toggleSort} />
              <TH sortKey="dob"        label="DOB"              sort={sort} onSort={toggleSort} />
              <th>Recording Period</th>
              <TH sortKey="created_at" label="Data Received"    sort={sort} onSort={toggleSort} />
              <th>Source</th>
              <th>Lead Type</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={TOTAL_COLS}>
                  <div className="rec-empty">No records match your search</div>
                </td>
              </tr>
            ) : (
              rows.map((p) =>
                editId === p.id ? (
                  <EditRow
                    key={p.id}
                    patient={p}
                    onSave={handleSave}
                    onCancel={() => setEditId(null)}
                  />
                ) : (
                  <tr key={p.id}>
                    <td><span className="rec-cell-id">{p.id}</span></td>
                    <td><span className="rec-cell-name">{p.name}</span></td>
                    <td><span className="rec-cell-mono">{p.age}</span></td>
                    <td><span className="rec-cell-mono">{p.sex}</span></td>
                    <td><span className="rec-cell-mono">{p.dob || "—"}</span></td>
                    <td><RecordingPeriodBadge patient={p} /></td>
                    <td><span className="rec-cell-mono">{p.created_at || "—"}</span></td>
                    <td><SourceBadge source={p.source} /></td>
                    <td><LeadTypeBadge patient={p} /></td>
                    <td>
                      {deleteId === p.id ? (
                        <div className="rec-delete-confirm">
                          <AlertTriangle size={12} strokeWidth={2} className="rec-delete-confirm__icon" />
                          {deleteError?.id === p.id
                            ? `Delete failed: ${deleteError.message}`
                            : `Delete ${p.id}?`}
                          <button
                            className="rec-btn rec-btn--danger"
                            onClick={() => handleDelete(p.id)}
                            disabled={deletingId === p.id}
                            aria-label={`Confirm delete for ${p.name}`}
                          >
                            {deletingId === p.id
                              ? <Loader2 size={12} className="rec-spin" />
                              : <Check size={12} strokeWidth={2.5} />}
                            {deletingId === p.id ? "Deleting" : "Confirm"}
                          </button>
                          <button
                            className="rec-btn rec-btn--ghost"
                            onClick={() => { setDeleteId(null); setDeleteError(null); }}
                            disabled={deletingId === p.id}
                            aria-label="Cancel delete"
                          >
                            <X size={12} strokeWidth={2.5} />
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="rec-actions">

                          {/* View ECG */}
                          <button
                            className="rec-btn rec-btn--primary"
                            onClick={() => onOpenPatient(p)}
                            aria-label={`Open ECG viewer for ${p.name}`}
                          >
                            <MonitorCheck size={12} strokeWidth={2} />
                            View ECG
                          </button>

                          {/* Edit — icon only */}
                          <button
                            className="rec-btn rec-btn--icon rec-btn--warning"
                            onClick={() => setEditId(p.id)}
                            aria-label={`Edit record for ${p.name}`}
                            title="Edit"
                          >
                            <Pencil size={13} strokeWidth={2} />
                          </button>

                          {/* Delete — icon only */}
                          <button
                            className="rec-btn rec-btn--icon rec-btn--danger"
                            onClick={() => { setDeleteId(p.id); setDeleteError(null); }}
                            aria-label={`Delete record for ${p.name}`}
                            title="Delete"
                          >
                            <Trash2 size={13} strokeWidth={2} />
                          </button>

                        </div>
                      )}
                    </td>
                  </tr>
                )
              )
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
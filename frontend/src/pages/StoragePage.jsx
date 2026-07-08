/**
 * StoragePage.jsx  —  Storage Management
 * ─────────────────────────────────────────────────────────────────────────────
 * Accessible from SettingsPage (tab / section — not sidebar).
 *
 * Features:
 *   - Disk space meter: green → yellow (<10 GB free) → red (<2 GB free)
 *   - Total H5 file count and size
 *   - Patient table sorted by file size (largest first)
 *   - Per-patient delete button (H5 only, PDFs preserved)
 *   - Confirmation modal before any deletion
 *   - Auto-refresh every 30s
 *   - All warnings and actions fire notifications
 *
 * Props:
 *   notify   fn  from useNotifications()
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

// ── Disk space meter ──────────────────────────────────────────────────────────
function DiskMeter({ totalGb, usedGb, freeGb, freePct, level }) {
  const usedPct  = ((usedGb / totalGb) * 100).toFixed(1);
  const barColor = level === "critical" ? "#e05050"
                 : level === "warning"  ? "#f5a623"
                 : "#34c77b";
  const bgColor  = level === "critical" ? "rgba(224,80,80,0.08)"
                 : level === "warning"  ? "rgba(245,166,35,0.08)"
                 : "rgba(52,199,123,0.05)";
  const label    = level === "critical" ? "⛔ CRITICAL — Less than 2 GB free"
                 : level === "warning"  ? "⚠ WARNING — Less than 10 GB free"
                 : "✓ Storage OK";

  return (
    <div style={{
      background:   bgColor,
      border:       `1px solid ${barColor}40`,
      borderLeft:   `3px solid ${barColor}`,
      borderRadius: 6,
      padding:      "12px 16px",
      marginBottom: 18,
    }}>
      <div style={{ display: "flex", alignItems: "center",
        justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ ...MONO, fontSize: 10, color: barColor }}>
          {label}
        </span>
        <span style={{ ...MONO, fontSize: 10, color: "#555" }}>
          {freeGb.toFixed(1)} GB free of {totalGb.toFixed(1)} GB
        </span>
      </div>

      {/* Bar */}
      <div style={{
        height: 8, background: "#1a1a1a",
        borderRadius: 4, overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          width:  `${Math.min(100, parseFloat(usedPct))}%`,
          background: barColor,
          borderRadius: 4,
          transition: "width 0.5s ease",
        }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between",
        marginTop: 4 }}>
        <span style={{ ...MONO, fontSize: 8, color: "#333" }}>
          Used: {usedGb.toFixed(1)} GB ({usedPct}%)
        </span>
        <span style={{ ...MONO, fontSize: 8, color: "#333" }}>
          Free: {freeGb.toFixed(1)} GB ({freePct}%)
        </span>
      </div>
    </div>
  );
}

// ── Summary strip ─────────────────────────────────────────────────────────────
function SummaryStrip({ totalH5Count, totalH5Mb, patientCount }) {
  const chips = [
    { label: "Patients",    value: patientCount },
    { label: "H5 Files",    value: totalH5Count },
    { label: "H5 Storage",  value: `${totalH5Mb >= 1024
        ? (totalH5Mb/1024).toFixed(2) + " GB"
        : totalH5Mb.toFixed(1) + " MB"}` },
  ];
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
      {chips.map(c => (
        <div key={c.label} style={{
          flex: 1, background: "#0f0f0f",
          border: "1px solid #1e1e1e", borderRadius: 6,
          padding: "10px 14px",
        }}>
          <div style={{ ...MONO, fontSize: 18, color: "#4f8ef7" }}>{c.value}</div>
          <div style={{ ...MONO, fontSize: 8, color: "#333", marginTop: 2 }}>{c.label}</div>
        </div>
      ))}
    </div>
  );
}

// ── Confirm delete modal ──────────────────────────────────────────────────────
function ConfirmModal({ patient, onConfirm, onCancel }) {
  return (
    <div style={{
      position:   "fixed",
      inset:      0,
      background: "rgba(0,0,0,0.75)",
      zIndex:     99998,
      display:    "flex",
      alignItems: "center",
      justifyContent: "center",
    }}>
      <div style={{
        background:   "#0f0f0f",
        border:       "1px solid #e05050",
        borderRadius: 8,
        padding:      "28px 32px",
        maxWidth:     400,
        width:        "90%",
        boxShadow:    "0 8px 40px rgba(0,0,0,0.8)",
      }}>
        <div style={{ ...MONO, fontSize: 13, color: "#e05050",
          marginBottom: 12 }}>
          ⚠ Confirm Deletion
        </div>
        <p style={{ fontSize: 13, color: "#bbb", lineHeight: 1.6,
          marginBottom: 8 }}>
          Delete all <strong style={{ color: "#e05050" }}>H5 ECG files</strong> for:
        </p>
        <div style={{
          background: "#161616", border: "1px solid #2a2a2a",
          borderRadius: 5, padding: "8px 14px", marginBottom: 16,
        }}>
          <span style={{ ...MONO, fontSize: 12, color: "#4f8ef7" }}>
            {patient.name}
          </span>
          <span style={{ ...MONO, fontSize: 10, color: "#333",
            marginLeft: 10 }}>
            {patient.id}
          </span>
          <span style={{ ...MONO, fontSize: 10, color: "#f5a623",
            display: "block", marginTop: 4 }}>
            {patient.h5_size_mb.toFixed(1)} MB will be freed
          </span>
        </div>
        <div style={{
          background: "rgba(52,199,123,0.07)",
          border: "1px solid rgba(52,199,123,0.2)",
          borderRadius: 4, padding: "6px 12px", marginBottom: 20,
        }}>
          <span style={{ fontSize: 11, color: "#34c77b" }}>
            ✓ PDF reports will be <strong>preserved</strong>.
            Patient record kept.
          </span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={onConfirm}
            style={{
              flex: 1, ...MONO, fontSize: 11,
              background: "rgba(224,80,80,0.15)",
              border:     "1px solid #e05050",
              color:      "#e05050",
              borderRadius: 5, padding: "8px 0",
              cursor: "pointer",
            }}>
            Delete H5 Files
          </button>
          <button
            onClick={onCancel}
            style={{
              flex: 1, ...MONO, fontSize: 11,
              background: "transparent",
              border:     "1px solid #2a2a2a",
              color:      "#555",
              borderRadius: 5, padding: "8px 0",
              cursor: "pointer",
            }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Patient row ───────────────────────────────────────────────────────────────
function PatientRow({ p, onDelete, deleting }) {
  const totalMb  = p.total_size_mb;
  const sizeStr  = totalMb >= 1024
    ? `${(totalMb/1024).toFixed(2)} GB`
    : `${totalMb.toFixed(1)} MB`;
  const h5Str    = p.h5_size_mb >= 1024
    ? `${(p.h5_size_mb/1024).toFixed(2)} GB`
    : `${p.h5_size_mb.toFixed(1)} MB`;
  const pdfStr   = p.pdf_size_mb > 0
    ? `${p.pdf_size_mb.toFixed(1)} MB PDF`
    : "no PDF";

  // Bar width relative to a 2GB max for visual scale
  const barPct   = Math.min(100, (totalMb / 2048) * 100);
  const barColor = totalMb > 1024 ? "#e05050"
                 : totalMb > 200  ? "#f5a623"
                 : "#4f8ef7";

  return (
    <div style={{
      background: "#0c0c0c",
      border:     "1px solid #161616",
      borderRadius: 6,
      padding:    "10px 14px",
      marginBottom: 6,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10,
        flexWrap: "wrap" }}>
        {/* ID + Name */}
        <span style={{ ...MONO, fontSize: 10,
          color: "#4f8ef7", minWidth: 50 }}>
          {p.id}
        </span>
        <span style={{ fontSize: 12, color: "#bbb", flex: 1,
          minWidth: 100, fontWeight: 500 }}>
          {p.name}
        </span>

        {/* Size chips */}
        <span style={{ ...MONO, fontSize: 9, color: "#555" }}>
          H5: {h5Str}
        </span>
        <span style={{ ...MONO, fontSize: 9, color: "#333" }}>
          · {pdfStr}
        </span>
        <span style={{ ...MONO, fontSize: 11, color: "#bbb",
          fontWeight: "bold", minWidth: 70, textAlign: "right" }}>
          {sizeStr}
        </span>

        {/* Delete button */}
        {p.has_h5 ? (
          <button
            onClick={() => onDelete(p)}
            disabled={deleting === p.id}
            style={{
              ...MONO, fontSize: 9,
              background: "rgba(224,80,80,0.08)",
              border:     "1px solid rgba(224,80,80,0.3)",
              color:      "#e05050",
              borderRadius: 4, padding: "4px 10px",
              cursor:     deleting === p.id ? "default" : "pointer",
              opacity:    deleting === p.id ? 0.5 : 1,
            }}>
            {deleting === p.id ? "Deleting…" : "🗑 Delete H5"}
          </button>
        ) : (
          <span style={{ ...MONO, fontSize: 8, color: "#2a2a2a",
            padding: "4px 10px" }}>
            no H5
          </span>
        )}
      </div>

      {/* Size bar */}
      <div style={{ marginTop: 6, height: 3,
        background: "#151515", borderRadius: 2 }}>
        <div style={{
          height: "100%",
          width:  `${barPct}%`,
          background: barColor,
          borderRadius: 2,
          transition: "width 0.4s ease",
        }} />
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function StoragePage({ notify }) {
  const [stats,     setStats]     = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState(null);
  const [confirmP,  setConfirmP]  = useState(null);   // patient pending delete
  const [deleting,  setDeleting]  = useState(null);   // patient id being deleted
  const timerRef  = useRef(null);
  const warnedRef = useRef(false);   // only warn once per session per level

  const fetchStats = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res  = await fetch("/api/storage/stats");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setStats(data);

      // Fire notification on first load or on level change
      if (!warnedRef.current) {
        if (data.warning_level === "critical") {
          notify?.({
            type:    "error",
            title:   "⛔ Storage Critical",
            message: `Only ${data.disk_free_gb.toFixed(1)} GB free. Delete old recordings immediately.`,
            duration: 12000,
          });
          warnedRef.current = true;
        } else if (data.warning_level === "warning") {
          notify?.({
            type:    "warning",
            title:   "⚠ Low Disk Space",
            message: `${data.disk_free_gb.toFixed(1)} GB free remaining. Consider deleting old H5 files.`,
            duration: 8000,
          });
          warnedRef.current = true;
        }
      }
    } catch (e) {
      setError(e.message);
      notify?.({ type: "error", title: "Storage stats failed", message: e.message });
    } finally {
      if (!silent) setLoading(false);
    }
  }, [notify]);

  // Initial load + auto-refresh every 30s
  useEffect(() => {
    fetchStats();
    timerRef.current = setInterval(() => fetchStats(true), 30000);
    return () => clearInterval(timerRef.current);
  }, [fetchStats]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!confirmP) return;
    const p = confirmP;
    setConfirmP(null);
    setDeleting(p.id);

    try {
      const res = await fetch(
        `/api/storage/patients/${p.id}/data`,
        {
          method:  "DELETE",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ confirm: true }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      const freed = p.h5_size_mb.toFixed(1);
      notify?.({
        type:    "success",
        title:   "H5 files deleted",
        message: `${p.name} — ${freed} MB freed. PDFs preserved.`,
      });
      warnedRef.current = false;   // allow re-warn after deletion
      fetchStats();
    } catch (e) {
      notify?.({ type: "error", title: "Deletion failed", message: e.message });
    } finally {
      setDeleting(null);
    }
  }, [confirmP, notify, fetchStats]);

  return (
    <div style={{ maxWidth: 720 }}>
      {/* Title row */}
      <div style={{ display: "flex", alignItems: "center",
        gap: 12, marginBottom: 16 }}>
        <span style={{ ...MONO, fontSize: 13, color: "#4f8ef7" }}>
          💾 STORAGE MANAGEMENT
        </span>
        <button
          onClick={() => { warnedRef.current = false; fetchStats(); }}
          disabled={loading}
          style={{
            ...MONO, fontSize: 9,
            background: "transparent",
            border:     "1px solid #222",
            color:      "#333",
            borderRadius: 4, padding: "4px 10px",
            cursor:     "pointer",
            marginLeft: "auto",
          }}>
          {loading ? "Refreshing…" : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div style={{
          background: "rgba(224,80,80,0.08)",
          border:     "1px solid rgba(224,80,80,0.3)",
          borderRadius: 5, padding: "10px 14px",
          color: "#e05050", fontSize: 11, marginBottom: 16,
        }}>
          {error}
        </div>
      )}

      {loading && !stats && (
        <p style={{ ...MONO, fontSize: 10, color: "#333" }}>Loading storage info…</p>
      )}

      {stats && (
        <>
          {/* Disk meter */}
          <DiskMeter
            totalGb   = {stats.disk_total_gb}
            usedGb    = {stats.disk_used_gb}
            freeGb    = {stats.disk_free_gb}
            freePct   = {stats.disk_free_pct}
            level     = {stats.warning_level}
          />

          {/* Summary strip */}
          <SummaryStrip
            totalH5Count  = {stats.total_h5_count}
            totalH5Mb     = {stats.total_h5_size_mb}
            patientCount  = {stats.patients.length}
          />

          {/* Info banner */}
          <div style={{
            background:   "rgba(79,142,247,0.06)",
            border:       "1px solid rgba(79,142,247,0.15)",
            borderRadius: 5, padding: "8px 14px",
            marginBottom: 14,
          }}>
            <p style={{ fontSize: 11, color: "#6a9ff7", margin: 0 }}>
              <strong>H5 files</strong> contain raw ECG data and are safe to delete
              after analysis. <strong>PDF reports</strong> are always preserved.
              Patient records (name, age, DOB) are never deleted by this tool.
            </p>
          </div>

          {/* Section label */}
          <div style={{ ...MONO, fontSize: 9, color: "#2a2a2a",
            marginBottom: 8, letterSpacing: "0.08em" }}>
            PATIENTS — SORTED BY FILE SIZE
          </div>

          {/* Patient rows */}
          {stats.patients.length === 0 && (
            <p style={{ ...MONO, fontSize: 10, color: "#252525" }}>
              No patient data found.
            </p>
          )}
          {stats.patients.map(p => (
            <PatientRow
              key      = {p.id}
              p        = {p}
              onDelete = {setConfirmP}
              deleting = {deleting}
            />
          ))}
        </>
      )}

      {/* Confirm modal */}
      {confirmP && (
        <ConfirmModal
          patient   = {confirmP}
          onConfirm = {handleDeleteConfirm}
          onCancel  = {() => setConfirmP(null)}
        />
      )}
    </div>
  );
}
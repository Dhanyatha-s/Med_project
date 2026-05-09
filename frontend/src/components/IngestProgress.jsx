/**
 * IngestProgress.jsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Shows a live transfer progress bar during data acquisition.
 * Appears as a floating panel in the bottom-right of the screen.
 *
 * Props:
 *   sessionId   string   — the session to track
 *   onViewECG   fn       — called with patientId when ECG is ready to view
 *   onDismiss   fn       — called when user clicks ✕
 */

import React, { useState } from "react";
import useIngestProgress from "../hooks/useIngestProgress";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

const METHOD_ICONS = {
  sd:     "💾",
  wifi:   "📡",
  usb:    "🔌",
  bt:     "🔵",
  manual: "📂",
  unknown:"📥",
};

function fmtSecs(s) {
  if (!s || s < 1) return "—";
  if (s < 60)   return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${Math.floor(s%60)}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function fmtMB(b) {
  if (!b) return "—";
  return b > 1e6 ? `${(b/1e6).toFixed(1)} MB` : `${Math.round(b/1e3)} KB`;
}

export default function IngestProgress({ sessionId, onViewECG, onDismiss }) {
  const [ecgReady,    setEcgReady]    = useState(false);
  const [patientId,   setPatientId]   = useState(null);
  const [dismissed,   setDismissed]   = useState(false);

  const { progress, error } = useIngestProgress(sessionId, (pid) => {
    setEcgReady(true);
    setPatientId(pid);
    if (onViewECG) onViewECG(pid);
  });

  if (dismissed || !sessionId) return null;

  const status     = progress?.status      ?? "connecting…";
  const pctR       = progress?.pct_received ?? 0;
  const pctW       = progress?.pct_written  ?? 0;
  const secsAvail  = progress?.seconds_available ?? 0;
  const leadNames  = progress?.lead_names   ?? [];
  const bytesTotal = progress?.bytes_total  ?? 0;
  const methodIcon = METHOD_ICONS[progress?.source_method] ?? "📥";
  const isComplete = status === "complete";
  const isError    = status === "error";
  const errMsg     = progress?.error_message ?? error ?? "";

  const borderColor = isComplete ? "#34c77b"
                    : isError    ? "#e05050"
                    : ecgReady   ? "#f5a623"
                    : "#4f8ef7";

  return (
    <div style={{
      position:     "fixed",
      bottom:       20,
      right:        20,
      width:        340,
      background:   "#0f0f0f",
      border:       `1px solid ${borderColor}40`,
      borderLeft:   `3px solid ${borderColor}`,
      borderRadius: 8,
      padding:      "14px 16px",
      zIndex:       9999,
      boxShadow:    "0 4px 24px rgba(0,0,0,0.6)",
    }}>

      {/* Header row */}
      <div style={{ display:"flex", justifyContent:"space-between",
        alignItems:"center", marginBottom:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <span style={{ fontSize:16 }}>{methodIcon}</span>
          <span style={{ ...MONO, fontSize:11, color:"#ccc", letterSpacing:"0.05em" }}>
            {isComplete ? "Transfer Complete" :
             isError    ? "Transfer Failed"   :
             "Receiving ECG…"}
          </span>
        </div>
        <button
          onClick={() => { setDismissed(true); if (onDismiss) onDismiss(); }}
          style={{ ...MONO, background:"transparent", border:"none",
            color:"#333", cursor:"pointer", fontSize:14, lineHeight:1 }}>
          ✕
        </button>
      </div>

      {/* Error state */}
      {isError && (
        <div style={{ ...MONO, fontSize:10, color:"#e05050",
          background:"rgba(224,80,80,0.08)", border:"1px solid rgba(224,80,80,0.2)",
          borderRadius:4, padding:"6px 8px", marginBottom:8 }}>
          ⚠ {errMsg || "Unknown error"}
        </div>
      )}

      {/* Dual progress bar: bytes received (grey) + samples written (blue) */}
      {!isError && (
        <div style={{ marginBottom:10 }}>
          {/* Bytes received bar */}
          <div style={{ display:"flex", justifyContent:"space-between",
            marginBottom:3 }}>
            <span style={{ ...MONO, fontSize:9, color:"#555" }}>
              Receiving {fmtMB(progress?.bytes_received)} / {fmtMB(bytesTotal)}
            </span>
            <span style={{ ...MONO, fontSize:9, color:"#555" }}>
              {pctR.toFixed(0)}%
            </span>
          </div>
          <div style={{ height:4, background:"#1a1a1a", borderRadius:2,
            overflow:"hidden", marginBottom:6 }}>
            <div style={{
              height:"100%", width:`${pctR}%`,
              background:"#444", borderRadius:2,
              transition:"width 0.5s ease",
            }} />
          </div>

          {/* Samples written bar */}
          <div style={{ display:"flex", justifyContent:"space-between",
            marginBottom:3 }}>
            <span style={{ ...MONO, fontSize:9, color:"#4f8ef7" }}>
              ECG written: {fmtSecs(secsAvail)} available
            </span>
            <span style={{ ...MONO, fontSize:9, color:"#4f8ef7" }}>
              {pctW.toFixed(0)}%
            </span>
          </div>
          <div style={{ height:6, background:"#1a1a1a", borderRadius:3,
            overflow:"hidden" }}>
            <div style={{
              height:"100%", width:`${isComplete ? 100 : pctW}%`,
              background: isComplete ? "#34c77b" : "#4f8ef7",
              borderRadius:3,
              transition:"width 0.5s ease",
              boxShadow: isComplete ? "none" : "0 0 8px rgba(79,142,247,0.5)",
            }} />
          </div>
        </div>
      )}

      {/* Leads detected */}
      {leadNames.length > 0 && (
        <div style={{ ...MONO, fontSize:9, color:"#333", marginBottom:8 }}>
          Detected: {leadNames.length}-lead ·{" "}
          {leadNames.slice(0, 6).join(" · ")}
          {leadNames.length > 6 ? ` +${leadNames.length - 6}` : ""}
        </div>
      )}

      {/* ECG ready notification */}
      {ecgReady && !isComplete && (
        <div style={{
          background:"rgba(245,166,35,0.08)",
          border:"1px solid rgba(245,166,35,0.3)",
          borderRadius:5, padding:"7px 10px", marginBottom:8,
          display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <span style={{ ...MONO, fontSize:9, color:"#f5a623" }}>
            ⚡ {fmtSecs(secsAvail)} of ECG ready to view
          </span>
          {patientId && (
            <button
              onClick={() => onViewECG && onViewECG(patientId)}
              style={{ ...MONO, fontSize:9,
                background:"rgba(245,166,35,0.15)",
                border:"1px solid rgba(245,166,35,0.4)",
                color:"#f5a623", borderRadius:4,
                padding:"3px 8px", cursor:"pointer" }}>
              View ECG →
            </button>
          )}
        </div>
      )}

      {/* Complete state */}
      {isComplete && (
        <div style={{
          background:"rgba(52,199,123,0.08)",
          border:"1px solid rgba(52,199,123,0.3)",
          borderRadius:5, padding:"7px 10px",
          display:"flex", alignItems:"center", justifyContent:"space-between",
        }}>
          <span style={{ ...MONO, fontSize:9, color:"#34c77b" }}>
            ✓ Full recording available — {fmtSecs(secsAvail)}
          </span>
          {patientId && (
            <button
              onClick={() => onViewECG && onViewECG(patientId)}
              style={{ ...MONO, fontSize:9,
                background:"rgba(52,199,123,0.15)",
                border:"1px solid rgba(52,199,123,0.4)",
                color:"#34c77b", borderRadius:4,
                padding:"3px 8px", cursor:"pointer" }}>
              Open ECG
            </button>
          )}
        </div>
      )}

      {/* Session ID (small, for debugging) */}
      <div style={{ ...MONO, fontSize:8, color:"#1e1e1e", marginTop:6 }}>
        session: {sessionId?.slice(0,8)}
      </div>
    </div>
  );
}

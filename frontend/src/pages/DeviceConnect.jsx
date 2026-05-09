/**
 * DeviceConnect.jsx  —  Data acquisition UI — 4 transfer methods
 * ─────────────────────────────────────────────────────────────────────────────
 * Four tabs: SD / USB | WiFi | Bluetooth | Manual Import
 * Each tab has a method-specific UI, connects to the correct backend endpoint,
 * and shows IngestProgress when a transfer is in progress.
 */

import React, { useState, useEffect } from "react";
import IngestProgress from "../components/IngestProgress";
import { useActiveTransfers } from "../hooks/useIngestProgress";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

const TABS = [
  { id:"file",  label:"SD / USB",   icon:"💾" },
  { id:"wifi",  label:"WiFi",       icon:"📡" },
  { id:"bt",    label:"Bluetooth",  icon:"🔵" },
  { id:"manual",label:"Manual",     icon:"📂" },
];

// ── Helper: detect laptop IP for WiFi instructions ───────────────────────────
function LaptopIP() {
  const [ip, setIp] = useState("loading…");
  useEffect(() => {
    fetch("/api/network/ip")
      .then(r => r.json())
      .then(d => setIp(d.ip ?? "unknown"))
      .catch(() => setIp("check ipconfig / ifconfig"));
  }, []);
  return <span style={{ color:"#4f8ef7" }}>{ip}</span>;
}

// ── Patient selector ─────────────────────────────────────────────────────────
function PatientSelect({ value, onChange }) {
  const [patients, setPatients] = useState([]);
  useEffect(() => {
    fetch("/api/patients").then(r => r.json()).then(setPatients).catch(() => {});
  }, []);
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      style={{ ...MONO, fontSize:11, background:"#111",
        border:"1px solid #2a2a2a", borderRadius:4,
        padding:"5px 10px", color:"#ccc", outline:"none", cursor:"pointer" }}>
      <option value="">Select patient…</option>
      {patients.map(p => (
        <option key={p.id} value={p.id}>{p.name} ({p.id})</option>
      ))}
      <option value="UNKNOWN">Unknown / new patient</option>
    </select>
  );
}

// ── Tab: SD card / USB file import ───────────────────────────────────────────
function SDTab({ onSessionCreated }) {
  const [patientId, setPatientId] = useState("");
  const [importing, setImporting] = useState(false);
  const [msg,       setMsg]       = useState("");

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".edf")) {
      setMsg("Only .edf files are supported.");
      return;
    }
    if (!patientId) {
      setMsg("Please select a patient first.");
      return;
    }

    setImporting(true);
    setMsg("Uploading…");

    const form = new FormData();
    form.append("file", file);
    form.append("patient_id", patientId);

    try {
      const res  = await fetch("/upload", {
        method: "POST",
        body:   form,
      });
      const data = await res.json();
      if (data.success || data.session_id) {
        setMsg(`Transfer started — session ${data.session_id?.slice(0,8)}`);
        onSessionCreated(data.session_id, patientId);
      } else {
        setMsg(`Error: ${data.error}`);
      }
    } catch (err) {
      setMsg(`Failed: ${err.message}`);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:16, lineHeight:1.7 }}>
        Insert the Holter recorder's SD card or connect via USB.<br/>
        Select the .edf file to import it into the system.
      </div>

      <div style={{ display:"flex", flexDirection:"column", gap:12, maxWidth:400 }}>
        <div>
          <label style={{ ...MONO, fontSize:9, color:"#555", letterSpacing:"0.08em",
            textTransform:"uppercase", display:"block", marginBottom:5 }}>
            Patient
          </label>
          <PatientSelect value={patientId} onChange={setPatientId} />
        </div>

        <div>
          <label style={{ ...MONO, fontSize:9, color:"#555", letterSpacing:"0.08em",
            textTransform:"uppercase", display:"block", marginBottom:5 }}>
            EDF File
          </label>
          <label style={{
            display:"inline-flex", alignItems:"center", gap:8,
            padding:"8px 16px",
            background: importing ? "rgba(79,142,247,0.05)" : "rgba(79,142,247,0.1)",
            border:"1px solid rgba(79,142,247,0.3)",
            borderRadius:6, cursor: importing ? "not-allowed" : "pointer",
            opacity: importing ? 0.6 : 1,
          }}>
            <input
              type="file" accept=".edf,.edf+"
              style={{ display:"none" }}
              onChange={handleFile}
              disabled={importing}
            />
            <span style={{ ...MONO, fontSize:11, color:"#4f8ef7" }}>
              {importing ? "Transferring…" : "💾  Select .edf file"}
            </span>
          </label>
        </div>

        {msg && (
          <div style={{ ...MONO, fontSize:10,
            color: msg.startsWith("Error") || msg.startsWith("Failed") ? "#e05050" : "#34c77b" }}>
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tab: WiFi ─────────────────────────────────────────────────────────────────
function WiFiTab({ onSessionCreated }) {
  const [sessions] = useActiveTransfersPair();

  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:20, lineHeight:1.8 }}>
        Configure the Holter recorder to send data to this computer over WiFi.<br/>
        Both devices must be on the same local network.
      </div>

      {/* Device configuration instructions */}
      <div style={{
        background:"#0d0d0d", border:"1px solid #1e1e1e",
        borderRadius:6, padding:"16px 20px", marginBottom:20, maxWidth:500,
      }}>
        <div style={{ ...MONO, fontSize:9, color:"#555", letterSpacing:"0.1em",
          textTransform:"uppercase", marginBottom:10 }}>
          Configure your Holter device
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {[
            ["Server IP",   <LaptopIP />],
            ["Port",        <span style={{color:"#4f8ef7"}}>5000</span>],
            ["Endpoint",    <span style={{color:"#4f8ef7"}}>/upload</span>],
            ["Method",      <span style={{color:"#888"}}>HTTP POST</span>],
            ["Content-Type",<span style={{color:"#888"}}>application/octet-stream</span>],
            ["Header",      <span style={{color:"#888"}}>X-Patient-Id: P001</span>],
          ].map(([label, value]) => (
            <div key={label} style={{ display:"flex", gap:12, alignItems:"baseline" }}>
              <span style={{ ...MONO, fontSize:9, color:"#444", minWidth:100 }}>{label}</span>
              <span style={{ ...MONO, fontSize:11 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Waiting indicator */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={{
          display:"inline-block", width:8, height:8, borderRadius:"50%",
          background: sessions.length > 0 ? "#34c77b" : "#222",
          animation: "livePulse 1.2s ease-in-out infinite",
        }} />
        <span style={{ ...MONO, fontSize:11, color: sessions.length > 0 ? "#34c77b" : "#333" }}>
          {sessions.length > 0
            ? `Receiving from device — ${sessions.length} active transfer`
            : "Waiting for device connection…"}
        </span>
      </div>
    </div>
  );
}

// ── Tab: Bluetooth ─────────────────────────────────────────────────────────────
function BTTab() {
  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:20, lineHeight:1.8 }}>
        Transfer the EDF recording via Bluetooth from the Holter device to this computer.
      </div>

      <div style={{
        background:"#0d0d0d", border:"1px solid #1e1e1e",
        borderRadius:6, padding:"16px 20px", marginBottom:20, maxWidth:500,
      }}>
        <div style={{ ...MONO, fontSize:9, color:"#555", letterSpacing:"0.1em",
          textTransform:"uppercase", marginBottom:12 }}>
          Steps
        </div>
        {[
          ["1", "Pair the Holter device with this computer in Bluetooth settings"],
          ["2", "On the device, select 'Transfer recording' → Bluetooth"],
          ["3", "Select this computer from the device's Bluetooth list"],
          ["4", "Accept the incoming file on this computer"],
          ["5", "The file will be automatically detected and processed"],
        ].map(([num, text]) => (
          <div key={num} style={{ display:"flex", gap:12, marginBottom:8,
            alignItems:"flex-start" }}>
            <span style={{ ...MONO, fontSize:10, color:"#4f8ef7",
              background:"rgba(79,142,247,0.1)", border:"1px solid rgba(79,142,247,0.2)",
              borderRadius:"50%", width:20, height:20, display:"flex",
              alignItems:"center", justifyContent:"center", flexShrink:0 }}>
              {num}
            </span>
            <span style={{ ...MONO, fontSize:10, color:"#777", lineHeight:1.6 }}>{text}</span>
          </div>
        ))}
      </div>

      <div style={{ ...MONO, fontSize:10, color:"#444", lineHeight:1.7 }}>
        💡 Testing without a device? Send the test EDF from your Android phone:<br/>
        <span style={{ color:"#333" }}>
          Files → long-press .edf → Share → Bluetooth → select this laptop
        </span>
      </div>
    </div>
  );
}

// ── Tab: Manual ───────────────────────────────────────────────────────────────
function ManualTab({ onSessionCreated }) {
  return <SDTab onSessionCreated={onSessionCreated} />;
}

// ── Helper hook (avoids importing from hooks/ twice) ─────────────────────────
function useActiveTransfersPair() {
  const sessions = useActiveTransfers();
  return [sessions];
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function DeviceConnect({ onOpenPatient }) {
  const [activeTab,  setActiveTab]  = useState("file");
  const [sessionId,  setSessionId]  = useState(null);
  const [patientId,  setPatientId]  = useState(null);

  const handleSessionCreated = (sid, pid) => {
    setSessionId(sid);
    setPatientId(pid);
  };

  const handleViewECG = (pid) => {
    if (onOpenPatient && pid) {
      // Fetch patient record and open ECG tab
      fetch(`/api/patients/${pid}`)
        .then(r => r.json())
        .then(patient => onOpenPatient(patient))
        .catch(() => {});
    }
  };

  return (
    <div style={{ flex:1, overflow:"auto", background:"#090909", padding:24 }}>

      {/* Header */}
      <div style={{ marginBottom:20 }}>
        <div style={{ ...MONO, fontSize:13, color:"#4f8ef7", letterSpacing:"0.1em" }}>
          DATA ACQUISITION
        </div>
        <div style={{ fontSize:11, color:"#2a2a2a", marginTop:4 }}>
          Transfer ECG recording from Holter monitor to this system
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display:"flex", gap:0,
        borderBottom:"1px solid #1a1a1a", marginBottom:0 }}>
        {TABS.map(tab => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{ ...MONO, fontSize:10, cursor:"pointer",
                padding:"8px 16px",
                background: active ? "#0f0f0f" : "transparent",
                border:"none",
                borderBottom: active ? "2px solid #4f8ef7" : "2px solid transparent",
                color: active ? "#4f8ef7" : "#2e2e2e",
                letterSpacing:"0.06em", display:"flex", alignItems:"center", gap:6,
              }}>
              <span>{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ background:"#0f0f0f", border:"1px solid #1a1a1a",
        borderTop:"none", borderRadius:"0 0 8px 8px", padding:"0 20px" }}>
        {activeTab === "file"   && <SDTab    onSessionCreated={handleSessionCreated} />}
        {activeTab === "wifi"   && <WiFiTab  onSessionCreated={handleSessionCreated} />}
        {activeTab === "bt"     && <BTTab    />}
        {activeTab === "manual" && <ManualTab onSessionCreated={handleSessionCreated} />}
      </div>

      {/* Active sessions list */}
      {sessionId && (
        <div style={{ marginTop:24 }}>
          <div style={{ ...MONO, fontSize:9, color:"#333", letterSpacing:"0.1em",
            textTransform:"uppercase", marginBottom:10 }}>
            Active Transfer
          </div>
          <IngestProgress
            sessionId={sessionId}
            onViewECG={handleViewECG}
            onDismiss={() => { setSessionId(null); setPatientId(null); }}
          />
        </div>
      )}

      <style>{`
        @keyframes livePulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.3; transform:scale(0.75); }
        }
      `}</style>
    </div>
  );
}

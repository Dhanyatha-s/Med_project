/**
 * DeviceConnect.jsx  —  Data acquisition UI — 4 transfer methods
 * ─────────────────────────────────────────────────────────────────────────────
 * Four tabs: SD / USB file import | WiFi | Bluetooth | Manual Import
 *
 * Changes vs original:
 *   - USBSerialTab: NEW — live port scan, connect/disconnect, status polling
 *   - BTTab: UPGRADED — live status polling, receive folder display, file count
 *   - Tabs re-ordered: SD | WiFi | USB Serial | Bluetooth | Manual
 */

import React, { useState, useEffect, useCallback } from "react";
import IngestProgress from "../components/IngestProgress";
import { useActiveTransfers } from "../hooks/useIngestProgress";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

const TABS = [
  { id:"file",   label:"SD / File",    icon:"💾" },
  { id:"wifi",   label:"WiFi",         icon:"📡" },
  { id:"usb",    label:"USB Serial",   icon:"🔌" },
  { id:"bt",     label:"Bluetooth",    icon:"🔵" },
  { id:"manual", label:"Manual",       icon:"📂" },
];

// ── Shared style constants ────────────────────────────────────────────────────
const CARD = {
  background:"#0d0d0d", border:"1px solid #1e1e1e",
  borderRadius:6, padding:"16px 20px", marginBottom:20, maxWidth:520,
};
const LABEL9 = { ...MONO, fontSize:9, color:"#555", letterSpacing:"0.1em",
  textTransform:"uppercase", marginBottom:12 };
const STATUS_DOT = (active) => ({
  display:"inline-block", width:8, height:8, borderRadius:"50%",
  background: active ? "#34c77b" : "#222",
  animation: active ? "livePulse 1.2s ease-in-out infinite" : "none",
  flexShrink:0,
});
const BTN = (variant = "primary") => ({
  ...MONO, fontSize:10, cursor:"pointer", padding:"7px 16px",
  borderRadius:4, border:"none", letterSpacing:"0.05em",
  background: variant === "primary" ? "#4f8ef7"
            : variant === "danger"  ? "#c0392b"
            : "#1a1a1a",
  color: variant === "ghost" ? "#555" : "#fff",
});

// ── Helper: laptop IP ─────────────────────────────────────────────────────────
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

// ── Helper: patient selector ──────────────────────────────────────────────────
function PatientSelect({ value, onChange }) {
  const [patients, setPatients] = useState([]);
  useEffect(() => {
    fetch("/api/patients").then(r => r.json()).then(setPatients).catch(() => {});
  }, []);
  return (
    <select value={value} onChange={e => onChange(e.target.value)}
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

// ── Tab: SD card / file import ────────────────────────────────────────────────
function SDTab({ onSessionCreated }) {
  const [patientId, setPatientId] = useState("");
  const [importing, setImporting] = useState(false);
  const [msg,       setMsg]       = useState("");

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".edf")) {
      setMsg("Only .edf files are accepted."); return;
    }
    const pid = patientId || "UNKNOWN";
    setImporting(true);
    setMsg("Uploading…");
    try {
      const res = await fetch("/upload", {
        method:"POST",
        headers:{
          "Content-Type":"application/octet-stream",
          "X-Patient-Id": pid,
          "X-Filename":   file.name,
          "Content-Length": file.size,
        },
        body: file,
      });
      const data = await res.json();
      if (data.session_id) {
        setMsg("Transfer started — processing…");
        onSessionCreated?.(data.session_id, pid);
      } else {
        setMsg(data.error || "Upload failed.");
      }
    } catch (err) {
      setMsg(`Error: ${err.message}`);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:20, lineHeight:1.8 }}>
        Insert the Holter recorder's SD card or connect via USB mass storage.<br/>
        Select the .edf file to import directly.
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:12, maxWidth:380 }}>
        <PatientSelect value={patientId} onChange={setPatientId} />
        <label style={{
          ...MONO, fontSize:10, cursor:"pointer",
          padding:"9px 18px", background:"#4f8ef7", borderRadius:4,
          color:"#fff", textAlign:"center", display:"block",
          opacity: importing ? 0.5 : 1,
        }}>
          {importing ? "Uploading…" : "📂  Select .edf file"}
          <input type="file" accept=".edf" onChange={handleFile}
            disabled={importing} style={{ display:"none" }} />
        </label>
        {msg && <div style={{ ...MONO, fontSize:10, color:"#888" }}>{msg}</div>}
      </div>
    </div>
  );
}

// ── Tab: WiFi ─────────────────────────────────────────────────────────────────
function WiFiTab() {
  const sessions = useActiveTransfers();
  const active   = (sessions || []).length > 0;

  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:20, lineHeight:1.8 }}>
        Configure the Holter recorder to send data to this computer over WiFi.<br/>
        Both devices must be on the same local network.
      </div>
      <div style={CARD}>
        <div style={LABEL9}>Configure your Holter device</div>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {[
            ["Server IP",    <LaptopIP />],
            ["Port",         <span style={{color:"#4f8ef7"}}>5000</span>],
            ["Endpoint",     <span style={{color:"#4f8ef7"}}>/upload</span>],
            ["Method",       <span style={{color:"#888"}}>HTTP POST</span>],
            ["Content-Type", <span style={{color:"#888"}}>application/octet-stream</span>],
            ["Header",       <span style={{color:"#888"}}>X-Patient-Id: P001</span>],
          ].map(([label, value]) => (
            <div key={label} style={{ display:"flex", gap:12, alignItems:"baseline" }}>
              <span style={{ ...MONO, fontSize:9, color:"#444", minWidth:100 }}>{label}</span>
              <span style={{ ...MONO, fontSize:11 }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={STATUS_DOT(active)} />
        <span style={{ ...MONO, fontSize:11, color: active ? "#34c77b" : "#333" }}>
          {active
            ? `Receiving from device — ${sessions.length} active transfer`
            : "Waiting for device connection…"}
        </span>
      </div>
    </div>
  );
}

// ── Tab: USB Serial ───────────────────────────────────────────────────────────
function USBSerialTab({ onSessionCreated }) {
  const [ports,      setPorts]      = useState([]);
  const [status,     setStatus]     = useState(null);
  const [patientId,  setPatientId]  = useState("UNKNOWN");
  const [selPort,    setSelPort]    = useState("");
  const [busy,       setBusy]       = useState(false);
  const [msg,        setMsg]        = useState("");

  // Poll ports + status
  const refresh = useCallback(() => {
    fetch("/api/usb/ports")
      .then(r => r.json())
      .then(data => {
        if (!data[0]?.error) setPorts(data);
      })
      .catch(() => {});
    fetch("/api/usb/status")
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const isConnected = status?.state === "receiving" || status?.state === "connecting";

  const handleConnect = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/usb/connect", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ port: selPort || null, patient_id: patientId }),
      });
      const d = await r.json();
      if (!d.ok) setMsg("Failed to start USB listener.");
      else setMsg(`Listening on ${d.port}…`);
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    await fetch("/api/usb/disconnect", { method:"POST" }).catch(() => {});
    setMsg("Disconnected.");
    setBusy(false);
    setTimeout(() => setMsg(""), 3000);
  };

  // Surface session_id when a transfer starts
  useEffect(() => {
    if (status?.session_id && status?.state === "receiving") {
      onSessionCreated?.(status.session_id, patientId);
    }
  }, [status?.session_id, status?.state]);

  const pct = status?.bytes_total > 0
    ? Math.round(status.bytes_recv / status.bytes_total * 100)
    : null;

  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:20, lineHeight:1.8 }}>
        Connect the Holter device via USB cable. The device appears as a CDC serial port.<br/>
        Select the port below or leave blank for auto-detection.
      </div>

      {/* Port selector */}
      <div style={CARD}>
        <div style={LABEL9}>Serial port</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <select
              value={selPort}
              onChange={e => setSelPort(e.target.value)}
              style={{ ...MONO, fontSize:11, background:"#111", flex:1,
                border:"1px solid #2a2a2a", borderRadius:4,
                padding:"5px 10px", color:"#ccc", outline:"none", cursor:"pointer" }}>
              <option value="">Auto-detect</option>
              {ports.map(p => (
                <option key={p.port} value={p.port}>
                  {p.port}  {p.description}{p.likely_holter ? "  ★" : ""}
                </option>
              ))}
            </select>
            <button onClick={refresh} style={BTN("ghost")} title="Refresh ports">↺</button>
          </div>
          <PatientSelect value={patientId} onChange={setPatientId} />
          <div style={{ display:"flex", gap:8 }}>
            {!isConnected
              ? <button onClick={handleConnect} style={BTN("primary")} disabled={busy}>
                  {busy ? "Connecting…" : "Connect"}
                </button>
              : <button onClick={handleDisconnect} style={BTN("danger")} disabled={busy}>
                  Disconnect
                </button>
            }
          </div>
          {msg && <div style={{ ...MONO, fontSize:10, color:"#888" }}>{msg}</div>}
        </div>
      </div>

      {/* Live status */}
      <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={STATUS_DOT(isConnected)} />
          <span style={{ ...MONO, fontSize:11, color: isConnected ? "#34c77b" : "#333" }}>
            {status?.state === "receiving"
              ? `Receiving — ${(status.bytes_recv / 1e6).toFixed(1)} MB received`
              : status?.state === "connecting"
              ? `Connecting to ${status.port || "device"}…`
              : status?.state === "complete"
              ? "Transfer complete ✓"
              : status?.state === "error"
              ? `Error: ${status.error}`
              : "Waiting for USB connection…"}
          </span>
        </div>

        {/* Progress bar */}
        {isConnected && pct !== null && (
          <div style={{ maxWidth:380, background:"#0d0d0d",
            border:"1px solid #1e1e1e", borderRadius:4, overflow:"hidden", height:6 }}>
            <div style={{
              height:"100%", background:"#4f8ef7",
              width:`${pct}%`, transition:"width 0.3s ease",
            }} />
          </div>
        )}
      </div>

      {/* Testing tip */}
      <div style={{ ...MONO, fontSize:10, color:"#2a2a2a", lineHeight:1.7, marginTop:20 }}>
        💡 Testing? Create a virtual serial pair:<br/>
        <span style={{ color:"#222" }}>
          Linux/macOS: socat PTY,link=/tmp/ttyHOLTER_TX,rawer PTY,link=/tmp/ttyHOLTER_RX,rawer &amp;<br/>
          Windows: install com0com → create COM10 ↔ COM11<br/>
          Then: python acquisition/simulate_device.py --mode usb --port /tmp/ttyHOLTER_TX
        </span>
      </div>
    </div>
  );
}

// ── Tab: Bluetooth ────────────────────────────────────────────────────────────
function BTTab({ onSessionCreated }) {
  const [status,     setStatus]    = useState(null);
  const [devices,    setDevices]   = useState([]);
  const [patientId,  setPatientId] = useState("UNKNOWN");
  const [busy,       setBusy]      = useState(false);
  const [msg,        setMsg]       = useState("");

  const refreshStatus = useCallback(() => {
    fetch("/api/bt/status").then(r => r.json()).then(setStatus).catch(() => {});
  }, []);

  const refreshDevices = useCallback(() => {
    fetch("/api/bt/devices").then(r => r.json()).then(setDevices).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshDevices();
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, [refreshStatus, refreshDevices]);

  const isWatching = status?.state === "watching";

  const handleStart = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/bt/start", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({ patient_id: patientId }),
      });
      const d = await r.json();
      if (!d.ok) setMsg("Failed to start BT receiver.");
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    await fetch("/api/bt/stop", { method:"POST" }).catch(() => {});
    setMsg("Stopped.");
    setBusy(false);
    setTimeout(() => setMsg(""), 3000);
  };

  const platform = status?.platform || "Unknown";

  return (
    <div style={{ padding:"20px 0" }}>
      <div style={{ ...MONO, fontSize:11, color:"#888", marginBottom:20, lineHeight:1.8 }}>
        Receive an EDF recording via Bluetooth OBEX Push. Pair your Holter device first,<br/>
        then initiate a file transfer from the device.
      </div>

      {/* Status + controls */}
      <div style={CARD}>
        <div style={LABEL9}>Bluetooth receiver</div>
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>

          {/* Platform + receive folder */}
          {status && (
            <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
              {[
                ["Platform",       platform],
                ["Receive folder", status.receive_folder || "detecting…"],
                ["Files received", String(status.files_received ?? 0)],
                ...(status.last_file ? [["Last file", status.last_file]] : []),
              ].map(([label, val]) => (
                <div key={label} style={{ display:"flex", gap:12, alignItems:"baseline" }}>
                  <span style={{ ...MONO, fontSize:9, color:"#444", minWidth:110 }}>{label}</span>
                  <span style={{ ...MONO, fontSize:10, color:"#888",
                    maxWidth:280, overflow:"hidden", textOverflow:"ellipsis",
                    whiteSpace:"nowrap" }}>{val}</span>
                </div>
              ))}
            </div>
          )}

          <PatientSelect value={patientId} onChange={setPatientId} />

          <div style={{ display:"flex", gap:8 }}>
            {!isWatching
              ? <button onClick={handleStart} style={BTN("primary")} disabled={busy}>
                  {busy ? "Starting…" : "Start receiving"}
                </button>
              : <button onClick={handleStop} style={BTN("danger")} disabled={busy}>
                  Stop
                </button>
            }
          </div>
          {msg && <div style={{ ...MONO, fontSize:10, color:"#888" }}>{msg}</div>}
        </div>
      </div>

      {/* Live status dot */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:20 }}>
        <span style={STATUS_DOT(isWatching)} />
        <span style={{ ...MONO, fontSize:11, color: isWatching ? "#34c77b" : "#333" }}>
          {isWatching
            ? `Watching for incoming transfers — ${status?.files_received ?? 0} file(s) processed`
            : status?.state === "error"
            ? `Error: ${status.error}`
            : "Not watching"}
        </span>
      </div>

      {/* Paired devices */}
      {devices.length > 0 && !devices[0]?.error && !devices[0]?.note && (
        <div style={{ ...CARD, marginBottom:0 }}>
          <div style={LABEL9}>Paired devices</div>
          {devices.map((d, i) => (
            <div key={i} style={{ ...MONO, fontSize:10, color:"#666",
              padding:"4px 0", borderBottom:"1px solid #181818" }}>
              {d.name || d.mac || d.id}
              {d.mac && <span style={{ color:"#333", marginLeft:8 }}>{d.mac}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Platform tips */}
      <div style={{ ...MONO, fontSize:10, color:"#2a2a2a", lineHeight:1.8, marginTop:16 }}>
        {platform === "Linux" && <>
          💡 Linux: install BlueZ obexd if not present:<br/>
          <span style={{ color:"#222" }}>sudo apt install bluez-obexd</span>
        </>}
        {platform === "Windows" && <>
          💡 Windows: received files appear in Documents\Bluetooth Exchange automatically.
        </>}
        {platform === "Darwin" && <>
          💡 macOS: received files appear in ~/Downloads automatically.
        </>}
        {!["Linux","Windows","Darwin"].includes(platform) && <>
          💡 Testing? python acquisition/simulate_device.py --mode bt --edf data/P001_test_300s.edf
        </>}
      </div>
    </div>
  );
}

// ── Tab: Manual ───────────────────────────────────────────────────────────────
function ManualTab({ onSessionCreated }) {
  return <SDTab onSessionCreated={onSessionCreated} />;
}

// ── Helper hook ───────────────────────────────────────────────────────────────
function useActiveTransfersPair() {
  const sessions = useActiveTransfers();
  return [sessions];
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function DeviceConnect({ onOpenPatient }) {
  const [activeTab, setActiveTab] = useState("file");
  const [sessionId, setSessionId] = useState(null);
  const [patientId, setPatientId] = useState(null);

  const handleSessionCreated = (sid, pid) => {
    setSessionId(sid);
    setPatientId(pid);
  };

  const handleViewECG = (pid) => {
    if (onOpenPatient && pid) {
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
        <div style={{ ...MONO, fontSize:10, color:"#2a2a2a", marginTop:4 }}>
          Transfer ECG recording from Holter monitor to this system
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display:"flex", gap:0, borderBottom:"1px solid #1a1a1a", marginBottom:0 }}>
        {TABS.map(tab => {
          const active = tab.id === activeTab;
          return (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              style={{ ...MONO, fontSize:10, cursor:"pointer",
                padding:"8px 16px", background: active ? "#0f0f0f" : "transparent",
                border:"none",
                borderBottom: active ? "2px solid #4f8ef7" : "2px solid transparent",
                color: active ? "#4f8ef7" : "#2e2e2e",
                letterSpacing:"0.06em", display:"flex", alignItems:"center", gap:6 }}>
              <span>{tab.icon}</span>{tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ background:"#0f0f0f", border:"1px solid #1a1a1a",
        borderTop:"none", borderRadius:"0 0 8px 8px", padding:"0 20px" }}>
        {activeTab === "file"   && <SDTab         onSessionCreated={handleSessionCreated} />}
        {activeTab === "wifi"   && <WiFiTab        />}
        {activeTab === "usb"    && <USBSerialTab   onSessionCreated={handleSessionCreated} />}
        {activeTab === "bt"     && <BTTab          onSessionCreated={handleSessionCreated} />}
        {activeTab === "manual" && <ManualTab      onSessionCreated={handleSessionCreated} />}
      </div>

      {/* Active transfer progress */}
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
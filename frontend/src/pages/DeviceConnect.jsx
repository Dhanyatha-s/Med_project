/**
 * DeviceConnect.jsx  —  Data acquisition UI
 * ─────────────────────────────────────────────────────────────────────────────
 * Design system: matches SettingsPage.jsx exactly.
 *   - Left sidebar navigation, plain text labels, 2px blue left-border active state
 *   - Tabler outline icons at 15px — consistent size across all nav items and buttons
 *   - No emoji anywhere
 *   - MONO token for labels, metadata, status, code values
 *   - One accent color (#378ADD), semantic green for live status (#34c77b)
 *   - Section dividers: uppercase monospace label + 0.5px border, same as Settings
 *   - ghostBtnStyle / primaryBtnStyle / dangerBtnStyle consistent with Settings
 *
 * Four transfer methods (sidebar nav):
 *   SD / File  |  WiFi  |  USB Serial  |  Bluetooth
 *
 * AppContext: not consumed directly — theme is passed in or inferred from tokens.
 * Props:
 *   onOpenPatient(patient)  — called after a transfer completes to open ECG viewer
 *   notify({ type, title, message })  — optional toast callback from parent
 *
 * API surface used (unchanged from original):
 *   GET  /api/patients
 *   GET  /api/network/ip
 *   POST /upload                    (SD / File panel) — sends X-Source-Method:
 *                                    "sd" or "usb" depending on the source
 *                                    toggle, so /upload tags the patient
 *                                    record with the real transfer source
 *                                    instead of always defaulting to "wifi".
 *   GET  /api/usb/ports
 *   GET  /api/usb/status
 *   POST /api/usb/connect
 *   POST /api/usb/disconnect
 *   GET  /api/bt/status
 *   GET  /api/bt/devices
 *   POST /api/bt/start
 *   POST /api/bt/stop
 *   GET  /api/patients/:id
 * ─────────────────────────────────────────────────────────────────────────────
 */

import React, { useState, useEffect, useCallback } from "react";
import IngestProgress from "../components/IngestProgress";
import { useActiveTransfers } from "../hooks/useIngestProgress";
import { useApp } from "../context/AppContext";

// ─── Typography / color tokens ────────────────────────────────────────────────
const MONO  = { fontFamily: "'Share Tech Mono', 'Consolas', monospace" };
const BLUE  = "#378ADD";
const GREEN = "#34c77b";
const MUTED = "#888";

// ─── Nav items ────────────────────────────────────────────────────────────────
// icon: Tabler outline icon name (ti-XXX), no emoji
const NAV_ITEMS = [
  { id: "file",   label: "SD / File",   icon: "ti-device-sd-card"    },
  { id: "wifi",   label: "WiFi",         icon: "ti-wifi"              },
  { id: "usb",    label: "USB Serial",   icon: "ti-usb"               },
  { id: "bt",     label: "Bluetooth",    icon: "ti-bluetooth"         },
];

// ─── Shared style helpers (mirrors SettingsPage tokens) ───────────────────────
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

const sectionDividerStyle = (theme) => ({
  fontSize:      10,
  letterSpacing: "0.09em",
  textTransform: "uppercase",
  color:         theme === "dark" ? "#444" : "#aaa",
  fontFamily:    "'Share Tech Mono', 'Consolas', monospace",
  marginBottom:  8,
  marginTop:     18,
  paddingBottom: 6,
  borderBottom:  `0.5px solid ${theme === "dark" ? "#1e1e1e" : "#e0e0e0"}`,
});

const primaryBtnStyle = (theme) => ({
  ...MONO,
  height:        30,
  padding:       "0 18px",
  fontSize:      11,
  letterSpacing: "0.05em",
  background:    theme === "dark"
    ? "rgba(55,138,221,0.1)" : "rgba(55,138,221,0.07)",
  border:        `0.5px solid rgba(55,138,221,0.45)`,
  color:         BLUE,
  borderRadius:  5,
  cursor:        "pointer",
  display:       "flex",
  alignItems:    "center",
  gap:           6,
});

const dangerBtnStyle = (theme) => ({
  ...MONO,
  height:        30,
  padding:       "0 18px",
  fontSize:      11,
  letterSpacing: "0.05em",
  background:    "transparent",
  border:        `0.5px solid rgba(192,57,43,0.4)`,
  color:         "#c0392b",
  borderRadius:  5,
  cursor:        "pointer",
  display:       "flex",
  alignItems:    "center",
  gap:           6,
});

const ghostBtnStyle = (theme) => ({
  ...MONO,
  height:        30,
  padding:       "0 14px",
  fontSize:      11,
  letterSpacing: "0.05em",
  background:    "transparent",
  border:        `0.5px solid ${theme === "dark" ? "#2a2a2a" : "#d4d4d4"}`,
  color:         MUTED,
  borderRadius:  5,
  cursor:        "pointer",
  display:       "flex",
  alignItems:    "center",
  gap:           6,
});

const iconBtnStyle = (theme) => ({
  ...ghostBtnStyle(theme),
  width:   30,
  padding: 0,
  justifyContent: "center",
  flexShrink: 0,
});

// ─── Shared components ────────────────────────────────────────────────────────

function SectionDivider({ title, theme }) {
  return <div style={sectionDividerStyle(theme)}>{title}</div>;
}

// Status dot with pulse animation for live state
function StatusDot({ live }) {
  return (
    <span style={{
      display:     "inline-block",
      width:       7,
      height:      7,
      borderRadius:"50%",
      flexShrink:  0,
      background:  live ? GREEN : (document.documentElement.style.colorScheme === "light" ? "#ccc" : "#2a2a2a"),
      animation:   live ? "dcPulse 1.4s ease-in-out infinite" : "none",
    }} />
  );
}

// Inline key–value pair for configuration display
function KVRow({ label, value, accent, theme }) {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline", marginBottom: 4 }}>
      <span style={{
        ...MONO, fontSize: 9, color: MUTED,
        minWidth: 120, letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}>
        {label}
      </span>
      <span style={{
        ...MONO, fontSize: 11,
        color: accent ? BLUE : (theme === "dark" ? "#bbb" : "#555"),
      }}>
        {value}
      </span>
    </div>
  );
}

// Patient selector — fetches /api/patients
function PatientSelect({ value, onChange, theme }) {
  const [patients, setPatients] = useState([]);

  useEffect(() => {
    fetch("/api/patients")
      .then(r => r.json())
      .then(setPatients)
      .catch(() => {});
  }, []);

  return (
    <div style={{ marginBottom: 0 }}>
      <label style={labelStyle}>Patient</label>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{ ...inputStyle(theme), cursor: "pointer" }}
      >
        <option value="">Select patient…</option>
        {patients.map(p => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.id})
          </option>
        ))}
        <option value="UNKNOWN">Unknown / new patient</option>
      </select>
    </div>
  );
}

// Progress bar for active transfers
function TransferProgressBar({ pct, theme }) {
  if (pct === null || pct === undefined) return null;
  return (
    <div style={{
      height:       4,
      background:   theme === "dark" ? "#1a1a1a" : "#e8e8e8",
      borderRadius: 2,
      overflow:     "hidden",
      maxWidth:     400,
      marginTop:    8,
    }}>
      <div style={{
        height:     "100%",
        background: BLUE,
        width:      `${Math.min(100, pct)}%`,
        borderRadius: 2,
        transition: "width 0.3s ease",
      }} />
    </div>
  );
}

// Info/tip block — same visual as Settings platform notes
function InfoBlock({ children, theme }) {
  return (
    <div style={{
      marginTop:    14,
      padding:      "10px 13px",
      background:   theme === "dark"
        ? "rgba(55,138,221,0.04)" : "rgba(55,138,221,0.03)",
      border:       `0.5px solid ${theme === "dark"
        ? "rgba(55,138,221,0.10)" : "rgba(55,138,221,0.18)"}`,
      borderRadius: 5,
    }}>
      <p style={{ ...MONO, fontSize: 10, color: MUTED,
        lineHeight: 1.8, margin: 0 }}>
        {children}
      </p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL: SD card / file import
// ─────────────────────────────────────────────────────────────────────────────
function SDPanel({ onSessionCreated, theme }) {
  const [patientId,  setPatientId]  = useState("");
  const [sourceType, setSourceType] = useState("sd"); // "sd" | "usb"
  const [importing,  setImporting]  = useState(false);
  const [msg,        setMsg]        = useState("");

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
        method: "POST",
        headers: {
          "Content-Type":    "application/octet-stream",
          "X-Patient-Id":    pid,
          "X-Filename":      file.name,
          "X-Source-Method": sourceType,
          "Content-Length":  file.size,
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

  const sourceOptions = [
    { id: "sd",  label: "SD Card",   icon: "ti-device-sd-card" },
    { id: "usb", label: "USB Cable", icon: "ti-usb"            },
  ];

  return (
    <div>
      <p style={{ ...MONO, fontSize: 11, color: MUTED,
        lineHeight: 1.8, marginBottom: 16 }}>
        Insert the recorder's SD card or connect via USB mass storage,
        then select the .edf file to import.
      </p>

      <label style={labelStyle}>Source</label>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {sourceOptions.map(opt => {
          const active = sourceType === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => setSourceType(opt.id)}
              aria-pressed={active}
              style={active ? primaryBtnStyle(theme) : ghostBtnStyle(theme)}
            >
              <i className={`ti ${opt.icon}`}
                style={{ fontSize: 15 }} aria-hidden="true" />
              {opt.label}
            </button>
          );
        })}
      </div>

      <PatientSelect value={patientId} onChange={setPatientId} theme={theme} />

      <div style={{ marginTop: 14 }}>
        <label style={{
          ...primaryBtnStyle(theme),
          display:      "inline-flex",
          userSelect:   "none",
          opacity:      importing ? 0.5 : 1,
        }}>
          <i className="ti ti-file-import"
            style={{ fontSize: 15 }} aria-hidden="true" />
          {importing ? "Uploading…" : "Select .edf file"}
          <input
            type="file" accept=".edf"
            onChange={handleFile}
            disabled={importing}
            style={{ display: "none" }}
          />
        </label>
      </div>

      {msg && (
        <p style={{ ...MONO, fontSize: 10, color: MUTED,
          marginTop: 10 }}>
          {msg}
        </p>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL: WiFi
// ─────────────────────────────────────────────────────────────────────────────
function WiFiPanel({ theme }) {
  const [ip, setIp] = useState("loading…");
  const sessions    = useActiveTransfers();
  const active      = (sessions || []).length > 0;

  useEffect(() => {
    fetch("/api/network/ip")
      .then(r => r.json())
      .then(d => setIp(d.ip ?? "unknown"))
      .catch(() => setIp("check ipconfig / ifconfig"));
  }, []);

  return (
    <div>
      <p style={{ ...MONO, fontSize: 11, color: MUTED,
        lineHeight: 1.8, marginBottom: 16 }}>
        Configure the Holter recorder to send data to this computer over WiFi.
        Both devices must be on the same local network.
      </p>

      <SectionDivider title="Device configuration" theme={theme} />
      <div style={{ marginTop: 10 }}>
        <KVRow label="Server IP"    value={ip}                           accent theme={theme} />
        <KVRow label="Port"         value="5000"                         accent theme={theme} />
        <KVRow label="Endpoint"     value="/upload"                      accent theme={theme} />
        <KVRow label="Method"       value="HTTP POST"                          theme={theme} />
        <KVRow label="Content-Type" value="application/octet-stream"          theme={theme} />
        <KVRow label="Header"       value="X-Patient-Id: P001"                theme={theme} />
      </div>

      <div style={{ display: "flex", alignItems: "center",
        gap: 8, marginTop: 16 }}>
        <StatusDot live={active} />
        <span style={{
          ...MONO, fontSize: 11,
          color: active ? GREEN : MUTED,
        }}>
          {active
            ? `Receiving from device — ${sessions.length} active transfer`
            : "Waiting for device connection…"}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL: USB Serial
// ─────────────────────────────────────────────────────────────────────────────
function USBSerialPanel({ onSessionCreated, theme, notify }) {
  const [ports,     setPorts]     = useState([]);
  const [status,    setStatus]    = useState(null);
  const [patientId, setPatientId] = useState("UNKNOWN");
  const [selPort,   setSelPort]   = useState("");
  const [busy,      setBusy]      = useState(false);
  const [msg,       setMsg]       = useState("");

  const refresh = useCallback(() => {
    fetch("/api/usb/ports")
      .then(r => r.json())
      .then(data => { if (!data[0]?.error) setPorts(data); })
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

  const isConnected = status?.state === "receiving"
    || status?.state === "connecting";

  const handleConnect = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/usb/connect", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ port: selPort || null, patient_id: patientId }),
      });
      const d = await r.json();
      if (!d.ok) {
        setMsg("Failed to start USB listener.");
        notify?.({ type: "error", title: "USB connect failed",
          message: "Could not open serial port." });
      } else {
        setMsg(`Listening on ${d.port}…`);
      }
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDisconnect = async () => {
    setBusy(true);
    await fetch("/api/usb/disconnect", { method: "POST" }).catch(() => {});
    setMsg("Disconnected.");
    setBusy(false);
    setTimeout(() => setMsg(""), 3000);
  };

  // Surface session_id when a transfer begins
  useEffect(() => {
    if (status?.session_id && status?.state === "receiving") {
      onSessionCreated?.(status.session_id, patientId);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.session_id, status?.state]);

  const pct = status?.bytes_total > 0
    ? Math.round(status.bytes_recv / status.bytes_total * 100)
    : null;

  const statusLabel = () => {
    switch (status?.state) {
      case "receiving":
        return `Receiving — ${(status.bytes_recv / 1e6).toFixed(1)} MB`;
      case "connecting":
        return `Connecting to ${status.port || "device"}…`;
      case "complete":
        return "Transfer complete";
      case "error":
        return `Error: ${status.error}`;
      default:
        return "Waiting for USB connection…";
    }
  };

  return (
    <div>
      <p style={{ ...MONO, fontSize: 11, color: MUTED,
        lineHeight: 1.8, marginBottom: 16 }}>
        Connect the Holter device via USB cable. The device appears as a CDC
        serial port. Select the port below or leave blank for auto-detection.
      </p>

      <SectionDivider title="Port selection" theme={theme} />
      <div style={{ display: "flex", gap: 8,
        alignItems: "flex-end", marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Serial port</label>
          <select
            value={selPort}
            onChange={e => setSelPort(e.target.value)}
            style={{ ...inputStyle(theme), cursor: "pointer",
              fontFamily: "'Share Tech Mono', 'Consolas', monospace",
              fontSize: 11 }}
          >
            <option value="">Auto-detect</option>
            {ports.map(p => (
              <option key={p.port} value={p.port}>
                {p.port}  {p.description}{p.likely_holter ? "  ★" : ""}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={refresh}
          style={iconBtnStyle(theme)}
          title="Refresh ports"
          aria-label="Refresh ports"
        >
          <i className="ti ti-refresh"
            style={{ fontSize: 15 }} aria-hidden="true" />
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        <PatientSelect value={patientId} onChange={setPatientId} theme={theme} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {!isConnected ? (
          <button
            onClick={handleConnect}
            disabled={busy}
            style={{ ...primaryBtnStyle(theme), opacity: busy ? 0.6 : 1 }}
          >
            <i className="ti ti-plug-connected"
              style={{ fontSize: 15 }} aria-hidden="true" />
            {busy ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <button
            onClick={handleDisconnect}
            disabled={busy}
            style={{ ...dangerBtnStyle(theme), opacity: busy ? 0.6 : 1 }}
          >
            <i className="ti ti-plug"
              style={{ fontSize: 15 }} aria-hidden="true" />
            Disconnect
          </button>
        )}
      </div>

      {msg && (
        <p style={{ ...MONO, fontSize: 10, color: MUTED, marginTop: 8 }}>
          {msg}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center",
        gap: 8, marginTop: 14 }}>
        <StatusDot live={isConnected} />
        <span style={{ ...MONO, fontSize: 11,
          color: isConnected ? GREEN : MUTED }}>
          {statusLabel()}
        </span>
      </div>

      {isConnected && (
        <TransferProgressBar pct={pct} theme={theme} />
      )}

      <InfoBlock theme={theme}>
        Testing? Create a virtual serial pair:{"\n"}
        Linux/macOS: socat PTY,link=/tmp/ttyHOLTER_TX,rawer PTY,link=/tmp/ttyHOLTER_RX,rawer &amp;{"\n"}
        Windows: install com0com → create COM10 ↔ COM11{"\n"}
        Then: python acquisition/simulate_device.py --mode usb --port /tmp/ttyHOLTER_TX
      </InfoBlock>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL: Bluetooth
// ─────────────────────────────────────────────────────────────────────────────
function BluetoothPanel({ onSessionCreated, theme, notify }) {
  const [status,    setStatus]    = useState(null);
  const [devices,   setDevices]   = useState([]);
  const [patientId, setPatientId] = useState("UNKNOWN");
  const [busy,      setBusy]      = useState(false);
  const [msg,       setMsg]       = useState("");

  const refreshStatus = useCallback(() => {
    fetch("/api/bt/status")
      .then(r => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  const refreshDevices = useCallback(() => {
    fetch("/api/bt/devices")
      .then(r => r.json())
      .then(setDevices)
      .catch(() => {});
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
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ patient_id: patientId }),
      });
      const d = await r.json();
      if (!d.ok) {
        setMsg("Failed to start BT receiver.");
        notify?.({ type: "error", title: "Bluetooth failed",
          message: "Could not start OBEX receiver." });
      }
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    await fetch("/api/bt/stop", { method: "POST" }).catch(() => {});
    setMsg("Stopped.");
    setBusy(false);
    setTimeout(() => setMsg(""), 3000);
  };

  const platform = status?.platform || "Unknown";

  const platformTip = () => {
    switch (platform) {
      case "Linux":
        return "Linux: install BlueZ obexd if not present — sudo apt install bluez-obexd";
      case "Windows":
        return "Windows: received files appear in Documents\\Bluetooth Exchange automatically.";
      case "Darwin":
        return "macOS: received files appear in ~/Downloads automatically.";
      default:
        return "Testing? python acquisition/simulate_device.py --mode bt --edf data/P001_test_300s.edf";
    }
  };

  const pairedDevices = Array.isArray(devices)
    && !devices[0]?.error
    && !devices[0]?.note
    ? devices
    : [];

  return (
    <div>
      <p style={{ ...MONO, fontSize: 11, color: MUTED,
        lineHeight: 1.8, marginBottom: 16 }}>
        Receive an EDF recording via Bluetooth OBEX Push. Pair your Holter
        device first, then initiate a file transfer from the device.
      </p>

      <SectionDivider title="Receiver status" theme={theme} />
      {status && (
        <div style={{ marginTop: 10 }}>
          <KVRow label="Platform"       value={platform}                        theme={theme} />
          <KVRow label="Receive folder" value={status.receive_folder || "—"}   theme={theme} />
          <KVRow label="Files received" value={String(status.files_received ?? 0)} theme={theme} />
          {status.last_file && (
            <KVRow label="Last file" value={status.last_file} theme={theme} />
          )}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <PatientSelect value={patientId} onChange={setPatientId} theme={theme} />
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        {!isWatching ? (
          <button
            onClick={handleStart}
            disabled={busy}
            style={{ ...primaryBtnStyle(theme), opacity: busy ? 0.6 : 1 }}
          >
            <i className="ti ti-bluetooth-connected"
              style={{ fontSize: 15 }} aria-hidden="true" />
            {busy ? "Starting…" : "Start receiving"}
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={busy}
            style={{ ...dangerBtnStyle(theme), opacity: busy ? 0.6 : 1 }}
          >
            <i className="ti ti-bluetooth-off"
              style={{ fontSize: 15 }} aria-hidden="true" />
            Stop
          </button>
        )}
      </div>

      {msg && (
        <p style={{ ...MONO, fontSize: 10, color: MUTED, marginTop: 8 }}>
          {msg}
        </p>
      )}

      <div style={{ display: "flex", alignItems: "center",
        gap: 8, marginTop: 14 }}>
        <StatusDot live={isWatching} />
        <span style={{ ...MONO, fontSize: 11,
          color: isWatching ? GREEN : MUTED }}>
          {isWatching
            ? `Watching for incoming transfers — ${status?.files_received ?? 0} file(s) processed`
            : status?.state === "error"
            ? `Error: ${status.error}`
            : "Not watching"}
        </span>
      </div>

      {pairedDevices.length > 0 && (
        <>
          <SectionDivider title="Paired devices" theme={theme} />
          <div style={{ marginTop: 8 }}>
            {pairedDevices.map((d, i) => (
              <div key={i} style={{
                ...MONO,
                fontSize:      11,
                color:         MUTED,
                padding:       "5px 0",
                borderBottom:  `0.5px solid ${theme === "dark" ? "#1a1a1a" : "#e8e8e8"}`,
                display:       "flex",
                gap:           12,
              }}>
                <i className="ti ti-device-mobile"
                  style={{ fontSize: 14, flexShrink: 0 }} aria-hidden="true" />
                <span>{d.name || d.id || "Unknown device"}</span>
                {d.mac && (
                  <span style={{ color: theme === "dark" ? "#333" : "#ccc" }}>
                    {d.mac}
                  </span>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      <InfoBlock theme={theme}>{platformTip()}</InfoBlock>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ROOT COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function DeviceConnect({ onOpenPatient, notify }) {
  const { theme } = useApp();
  const [activeTab, setActiveTab] = useState("file");
  const [sessionId, setSessionId] = useState(null);
  const [patientId, setPatientId] = useState(null);

  const bg        = theme === "dark" ? "#090909" : "#f7f7f7";
  const sidebarBg = theme === "dark" ? "#0c0c0c" : "#f0f0f0";
  const borderC   = theme === "dark" ? "#1a1a1a" : "#e0e0e0";
  const text      = theme === "dark" ? "#bbb"    : "#333";

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
    <div style={{
      flex:       1,
      display:    "flex",
      overflow:   "hidden",
      background: bg,
      color:      text,
      fontFamily: "'IBM Plex Sans', 'Segoe UI', sans-serif",
      fontSize:   13,
    }}>

      {/* ── Left sidebar nav ─────────────────────────────────────────────── */}
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
            ...MONO,
            fontSize:      11,
            color:         theme === "dark" ? "#ccc" : "#555",
            letterSpacing: "0.09em",
            textTransform: "uppercase",
          }}>
            Acquisition
          </div>
          <div style={{
            ...MONO,
            fontSize:  9,
            color:     MUTED,
            marginTop: 3,
          }}>
            Data transfer
          </div>
        </div>

        <nav style={{ flex: 1, padding: "8px 0" }}>
          {NAV_ITEMS.map((item) => {
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id)}
                style={{
                  display:     "flex",
                  alignItems:  "center",
                  gap:         9,
                  width:       "100%",
                  padding:     "8px 14px",
                  background:  active
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
            );
          })}
        </nav>
      </aside>

      {/* ── Content area ─────────────────────────────────────────────────── */}
      <main style={{
        flex:          1,
        overflowY:     "auto",
        padding:       "22px 26px",
        display:       "flex",
        flexDirection: "column",
        gap:           0,
      }}>
        {activeTab === "file" && (
          <SDPanel
            onSessionCreated={handleSessionCreated}
            theme={theme}
          />
        )}
        {activeTab === "wifi" && (
          <WiFiPanel theme={theme} />
        )}
        {activeTab === "usb" && (
          <USBSerialPanel
            onSessionCreated={handleSessionCreated}
            theme={theme}
            notify={notify}
          />
        )}
        {activeTab === "bt" && (
          <BluetoothPanel
            onSessionCreated={handleSessionCreated}
            theme={theme}
            notify={notify}
          />
        )}

        {/* Active transfer progress — same visual language as the rest */}
        {sessionId && (
          <div style={{ marginTop: 24 }}>
            <div style={{
              ...MONO,
              fontSize:      10,
              color:         MUTED,
              letterSpacing: "0.09em",
              textTransform: "uppercase",
              marginBottom:  10,
              paddingBottom: 6,
              borderBottom:  `0.5px solid ${borderC}`,
            }}>
              Active transfer
            </div>
            <IngestProgress
              sessionId={sessionId}
              onViewECG={handleViewECG}
              onDismiss={() => {
                setSessionId(null);
                setPatientId(null);
              }}
            />
          </div>
        )}
      </main>

      {/* Pulse animation — scoped to this component */}
      <style>{`
        @keyframes dcPulse {
          0%,100% { opacity:1; transform:scale(1); }
          50%      { opacity:0.3; transform:scale(0.7); }
        }
      `}</style>
    </div>
  );
}
/**
 * RecordsPage.jsx
 * Patient records — sortable, searchable, with inline edit and EDF import.
 *
 * NEW in this version:
 *   • Edit button per row → inline edit form (name, age, sex, dob)
 *   • Save calls PATCH /api/patients/<id>
 *   • Import EDF button → calls POST /api/import with file path
 *   • Legend row showing beat colour codes
 */

import React, { useState } from "react";

const MONO = { fontFamily: "'Share Tech Mono', monospace" };

// ── Beat colour legend (matches ECGCanvas beat colouring) ─────────────────────
const BEAT_LEGEND = [
  { label: "Normal (N)",    color: "#34c77b" },
  { label: "Ventricular (V)", color: "#e05050" },
  { label: "Atrial (A)",    color: "#a78bfa" },
  { label: "Artefact (Art)", color: "#f5a623" },
  { label: "Unknown (?)",   color: "#888" },
];

function Badge({ text, color }) {
  return (
    <span style={{
      ...MONO, fontSize: 9, padding: "2px 6px", borderRadius: 3,
      background: `${color}18`, border: `1px solid ${color}40`, color,
    }}>{text}</span>
  );
}

function fmtDur(hr) {
  if (!hr) return "—";
  const h = Math.floor(hr), m = Math.round((hr - h) * 60);
  return `${h}h ${m.toString().padStart(2, "0")}m`;
}

// ── Inline edit row ────────────────────────────────────────────────────────────
function EditRow({ patient, onSave, onCancel }) {
  const [form, setForm] = useState({
    name:       patient.name       ?? "",
    age:        patient.age        ?? "",
    sex:        patient.sex        ?? "M",
    dob:        patient.dob        ?? "",
    created_at: patient.created_at ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState("");

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setErr("");
    try {
      const res = await fetch(`/api/patients/${patient.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const updated = await res.json();
      onSave(updated);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputStyle = {
    ...MONO, fontSize: 11,
    background: "#111", border: "1px solid #2a2a2a",
    borderRadius: 3, padding: "3px 6px", color: "#ccc",
    outline: "none", width: "100%",
  };

  return (
    <tr style={{ background: "rgba(79,142,247,0.06)" }}>
      {/* ID — not editable */}
      <td style={{ ...MONO, fontSize: 11, color: "#4f8ef7", padding: "8px 12px",
        borderBottom: "1px solid #111" }}>{patient.id}</td>

      {/* Name */}
      <td style={{ padding: "8px 8px", borderBottom: "1px solid #111" }}>
        <input value={form.name} onChange={set("name")} style={inputStyle} />
      </td>

      {/* Age */}
      <td style={{ padding: "8px 6px", borderBottom: "1px solid #111" }}>
        <input value={form.age} onChange={set("age")} style={{ ...inputStyle, width: 40 }}
          type="number" min={0} max={130} />
      </td>

      {/* Sex */}
      <td style={{ padding: "8px 6px", borderBottom: "1px solid #111" }}>
        <select value={form.sex} onChange={set("sex")}
          style={{ ...inputStyle, width: 50 }}>
          <option value="M">M</option>
          <option value="F">F</option>
          <option value="O">O</option>
        </select>
      </td>

      {/* DOB */}
      <td style={{ padding: "8px 6px", borderBottom: "1px solid #111" }}>
        <input value={form.dob} onChange={set("dob")} style={{ ...inputStyle, width: 100 }}
          placeholder="YYYY-MM-DD" />
      </td>

      {/* Recorded */}
      <td style={{ padding: "8px 6px", borderBottom: "1px solid #111" }}>
        <input value={form.created_at} onChange={set("created_at")}
          style={{ ...inputStyle, width: 100 }} placeholder="YYYY-MM-DD" />
      </td>

      {/* 3-lead, 12-lead, SR — not editable inline */}
      <td colSpan={3} style={{ borderBottom: "1px solid #111" }} />

      {/* Actions */}
      <td style={{ padding: "8px 10px", borderBottom: "1px solid #111" }}>
        <div style={{ display: "flex", gap: 6, flexDirection: "column" }}>
          {err && <span style={{ ...MONO, fontSize: 9, color: "#ff5040" }}>{err}</span>}
          <div style={{ display: "flex", gap: 5 }}>
            <button onClick={save} disabled={saving}
              style={{ ...MONO, fontSize: 10,
                background: "rgba(52,199,123,0.12)", border: "1px solid rgba(52,199,123,0.3)",
                color: "#34c77b", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
              {saving ? "…" : "Save"}
            </button>
            <button onClick={onCancel}
              style={{ ...MONO, fontSize: 10,
                background: "transparent", border: "1px solid #222",
                color: "#444", borderRadius: 4, padding: "3px 8px", cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </div>
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function RecordsPage({ patients: initialPatients, h5Files, onOpenPatient }) {
  const [patients, setPatients] = useState(initialPatients);
  const [sort,     setSort]     = useState({ key: "id", dir: 1 });
  const [search,   setSearch]   = useState("");
  const [editId,   setEditId]   = useState(null);   // patient id being edited
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");

  // Sync if parent passes updated list
  React.useEffect(() => { setPatients(initialPatients); }, [initialPatients]);

  const toggle = key => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }));

  const enriched = patients.map(p => {
    const f3  = h5Files.find(f => f.filename === p.h5_3lead);
    const f12 = h5Files.find(f => f.filename === p.h5_12lead);
    return { ...p,
      dur3: f3?.duration_hr, dur12: f12?.duration_hr,
      sr: f3?.sr ?? f12?.sr ?? 250,
      has3: !!f3, has12: !!f12,
    };
  });

  const rows = enriched
    .filter(p => !search ||
      p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.id?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const av = a[sort.key] ?? "", bv = b[sort.key] ?? "";
      return sort.dir * (av < bv ? -1 : av > bv ? 1 : 0);
    });

  // Save edited patient back into local state
  const handleSave = (updated) => {
    setPatients(prev => prev.map(p => p.id === updated.id ? { ...p, ...updated } : p));
    setEditId(null);
  };

  // EDF import via file input
  const handleImport = async (e, patientId) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportMsg("Importing EDF…");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("patient_id", patientId);
      const res = await fetch("/api/import", { method: "POST", body: form });
      const data = await res.json();
      if (data.success) {
        setImportMsg(`Imported: ${data.lead_names?.join(", ")} · ${data.duration_hours?.toFixed(1)}h`);
        setTimeout(() => setImportMsg(""), 4000);
      } else {
        setImportMsg(`Error: ${data.error}`);
      }
    } catch (err) {
      setImportMsg(`Failed: ${err.message}`);
    } finally {
      setImporting(false);
      e.target.value = "";
    }
  };

  const TH = ({ k, label }) => (
    <th onClick={() => toggle(k)} style={{
      ...MONO, fontSize: 9, color: sort.key === k ? "#4f8ef7" : "#2e2e2e",
      padding: "9px 12px", textAlign: "left", cursor: "pointer",
      letterSpacing: "0.1em", textTransform: "uppercase",
      borderBottom: "1px solid #1a1a1a", userSelect: "none", whiteSpace: "nowrap",
    }}>
      {label}{sort.key === k ? (sort.dir > 0 ? " ↑" : " ↓") : ""}
    </th>
  );

  return (
    <div style={{ flex: 1, overflow: "auto", background: "#090909", padding: 20 }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 10 }}>
        <div>
          <div style={{ ...MONO, fontSize: 13, color: "#4f8ef7", letterSpacing: "0.1em" }}>
            PATIENT RECORDS
          </div>
          <div style={{ fontSize: 11, color: "#2a2a2a", marginTop: 3 }}>
            {rows.length} of {patients.length} patients
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {importMsg && (
            <span style={{ ...MONO, fontSize: 10,
              color: importMsg.startsWith("Error") || importMsg.startsWith("Failed")
                ? "#ff5040" : "#34c77b" }}>
              {importMsg}
            </span>
          )}
          <input
            placeholder="Search name or ID…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ ...MONO, fontSize: 11, background: "#111",
              border: "1px solid #1e1e1e", borderRadius: 5,
              padding: "6px 12px", color: "#777", outline: "none", width: 200 }}
          />
        </div>
      </div>

      {/* Beat colour legend */}
      <div style={{ display: "flex", gap: 10, alignItems: "center",
        marginBottom: 14, flexWrap: "wrap" }}>
        <span style={{ ...MONO, fontSize: 9, color: "#333", letterSpacing: "0.1em" }}>
          BEAT TYPES:
        </span>
        {BEAT_LEGEND.map(({ label, color }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 10, height: 10, borderRadius: 2,
              background: `${color}30`, border: `1px solid ${color}` }} />
            <span style={{ ...MONO, fontSize: 9, color: "#444" }}>{label}</span>
          </div>
        ))}
        <span style={{ ...MONO, fontSize: 9, color: "#2a2a2a", marginLeft: 4 }}>
          · beat colouring active in ECG viewer when analysis engine runs
        </span>
      </div>

      {/* Table */}
      <div style={{ border: "1px solid #171717", borderRadius: 6, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ background: "#0d0d0d" }}>
            <tr>
              <TH k="id"         label="ID"        />
              <TH k="name"       label="Name"      />
              <TH k="age"        label="Age"       />
              <TH k="sex"        label="Sex"       />
              <TH k="dob"        label="DOB"       />
              <TH k="created_at" label="Recorded"  />
              <th style={{ ...MONO, fontSize: 9, color: "#2e2e2e", padding: "9px 12px",
                textAlign: "left", letterSpacing: "0.1em", textTransform: "uppercase",
                borderBottom: "1px solid #1a1a1a" }}>3-LEAD</th>
              <th style={{ ...MONO, fontSize: 9, color: "#2e2e2e", padding: "9px 12px",
                textAlign: "left", letterSpacing: "0.1em", textTransform: "uppercase",
                borderBottom: "1px solid #1a1a1a" }}>12-LEAD</th>
              <th style={{ ...MONO, fontSize: 9, color: "#2e2e2e", padding: "9px 12px",
                textAlign: "left", letterSpacing: "0.1em", textTransform: "uppercase",
                borderBottom: "1px solid #1a1a1a" }}>SR</th>
              <th style={{ borderBottom: "1px solid #1a1a1a", padding: "9px 12px",
                ...MONO, fontSize: 9, color: "#2e2e2e",
                letterSpacing: "0.1em", textTransform: "uppercase",
                textAlign: "left" }}>ACTIONS</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ padding: "30px 12px", textAlign: "center",
                  ...MONO, fontSize: 11, color: "#222" }}>No records found</td>
              </tr>
            ) : rows.map((p, i) => (
              editId === p.id
                ? <EditRow key={p.id} patient={p}
                    onSave={handleSave}
                    onCancel={() => setEditId(null)} />
                : (
                  <tr key={p.id}
                    style={{ background: i % 2 === 0 ? "#090909" : "#0c0c0c" }}
                    onMouseEnter={e => e.currentTarget.style.background = "rgba(79,142,247,0.04)"}
                    onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? "#090909" : "#0c0c0c"}
                  >
                    <td style={{ ...MONO, fontSize: 11, color: "#4f8ef7",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.id}</td>
                    <td style={{ fontSize: 12, color: "#aaa",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.name}</td>
                    <td style={{ ...MONO, fontSize: 11, color: "#444",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.age}</td>
                    <td style={{ ...MONO, fontSize: 11, color: "#444",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.sex}</td>
                    <td style={{ ...MONO, fontSize: 11, color: "#333",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.dob}</td>
                    <td style={{ ...MONO, fontSize: 11, color: "#333",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.created_at}</td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #111" }}>
                      {p.has3
                        ? <Badge text={fmtDur(p.dur3)} color="#34c77b" />
                        : <span style={{ ...MONO, fontSize: 10, color: "#1e1e1e" }}>—</span>}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #111" }}>
                      {p.has12
                        ? <Badge text={fmtDur(p.dur12)} color="#4f8ef7" />
                        : <span style={{ ...MONO, fontSize: 10, color: "#1e1e1e" }}>—</span>}
                    </td>
                    <td style={{ ...MONO, fontSize: 11, color: "#333",
                      padding: "10px 12px", borderBottom: "1px solid #111" }}>{p.sr} Hz</td>

                    {/* Actions */}
                    <td style={{ padding: "10px 10px", borderBottom: "1px solid #111" }}>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                        {/* View ECG */}
                        <button onClick={() => onOpenPatient(p)}
                          style={{ ...MONO, fontSize: 10,
                            background: "rgba(79,142,247,0.1)",
                            border: "1px solid rgba(79,142,247,0.25)",
                            color: "#4f8ef7", borderRadius: 4,
                            padding: "4px 8px", cursor: "pointer" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(79,142,247,0.2)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(79,142,247,0.1)"}
                        >View ECG →</button>

                        {/* Edit */}
                        <button onClick={() => setEditId(p.id)}
                          style={{ ...MONO, fontSize: 10,
                            background: "rgba(245,166,35,0.08)",
                            border: "1px solid rgba(245,166,35,0.25)",
                            color: "#f5a623", borderRadius: 4,
                            padding: "4px 8px", cursor: "pointer" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgba(245,166,35,0.18)"}
                          onMouseLeave={e => e.currentTarget.style.background = "rgba(245,166,35,0.08)"}
                        >✏ Edit</button>

                        {/* Import EDF */}
                        <label style={{ cursor: "pointer" }}>
                          <input type="file" accept=".edf,.edf+"
                            style={{ display: "none" }}
                            onChange={e => handleImport(e, p.id)}
                            disabled={importing}
                          />
                          <span style={{ ...MONO, fontSize: 10,
                            background: "rgba(52,199,123,0.08)",
                            border: "1px solid rgba(52,199,123,0.25)",
                            color: "#34c77b", borderRadius: 4,
                            padding: "4px 8px", cursor: importing ? "not-allowed" : "pointer",
                            opacity: importing ? 0.5 : 1,
                            display: "inline-block",
                          }}
                            onMouseEnter={e => e.currentTarget.style.background = "rgba(52,199,123,0.18)"}
                            onMouseLeave={e => e.currentTarget.style.background = "rgba(52,199,123,0.08)"}
                          >⬆ Import EDF</span>
                        </label>
                      </div>
                    </td>
                  </tr>
                )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

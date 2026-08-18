/**
 * API client for the FastAPI backend.
 * The Electron shell will continue to use HTTP against the local FastAPI process.
 */

const BASE = process.env.REACT_APP_API_URL || "http://127.0.0.1:8000";

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${path}`);
  return res.json();
}

export async function getPatients() {
  return get("/api/v1/patients");
}

export async function getPatient(patientId) {
  return get(`/api/v1/patients/${patientId}`);
}

export async function getRecordings(patientId) {
  return get(`/api/v1/patients/${patientId}/recordings`);
}

/**
 * Fetch the latest available recording for a patient.
 * The old nLeads parameter is retained for UI compatibility; lead count is
 * now determined by recording metadata and may be anywhere from 1 to 12.
 */
export async function getAllLeads(patientId, _nLeads, startSec, durationSec = 10) {
  const recordings = await getRecordings(patientId);
  if (!recordings.length) throw new Error("No ECG recording is registered for this patient");

  const recording = recordings[0];
  const data = await get(
    `/api/v1/recordings/${recording.id}/ecg?start_sec=${startSec.toFixed(2)}&duration_sec=${durationSec}`,
  );

  const leads = {};
  data.lead_names.forEach((name, index) => {
    leads[name] = data.samples.map((row) => row[index]);
  });

  return {
    leads,
    sr: data.sampling_rate_hz,
    start: data.start_sec,
    duration: data.duration_sec,
    leadCount: data.lead_count,
    leadNames: data.lead_names,
    recordingId: data.recording_id,
  };
}

export async function getLead(patientId, nLeads, leadName, startSec, durationSec = 10) {
  const all = await getAllLeads(patientId, nLeads, startSec, durationSec);
  if (!all.leads[leadName]) throw new Error(`Lead not found: ${leadName}`);
  return {
    lead: leadName,
    sr: all.sr,
    start: all.start,
    samples: all.leads[leadName],
    duration: all.duration,
  };
}

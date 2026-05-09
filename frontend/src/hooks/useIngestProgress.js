/**
 * useIngestProgress.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls GET /api/transfer/status/<session_id> every 2 seconds.
 * Calls onReady(patientId) when 60+ seconds of ECG are available.
 * Stops polling when status is 'complete' or 'error'.
 *
 * Usage:
 *   const progress = useIngestProgress(sessionId, (patientId) => {
 *     openPatient(patientId);   // open ECG tab automatically
 *   });
 */

import { useState, useEffect, useRef, useCallback } from "react";

const POLL_INTERVAL_MS  = 2000;   // poll every 2 seconds
const ECG_READY_SECS    = 60;     // notify when this many seconds available

export default function useIngestProgress(sessionId, onReady) {
  const [progress, setProgress] = useState(null);
  const [error,    setError]    = useState(null);
  const notifiedRef = useRef(false);
  const timerRef    = useRef(null);

  const poll = useCallback(async () => {
    if (!sessionId) return;

    try {
      const res  = await fetch(`/api/transfer/status/${sessionId}`);
      if (res.status === 404) {
        // Session not in DB yet — keep polling
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setProgress(data);
      setError(null);

      // Notify caller when enough ECG is available to view
      if (
        !notifiedRef.current &&
        data.seconds_available >= ECG_READY_SECS &&
        onReady &&
        data.patient_id
      ) {
        notifiedRef.current = true;
        onReady(data.patient_id);
      }

      // Stop polling when terminal state reached
      if (data.status === "complete" || data.status === "error") {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    } catch (err) {
      setError(err.message);
    }
  }, [sessionId, onReady]);

  useEffect(() => {
    if (!sessionId) {
      setProgress(null);
      setError(null);
      notifiedRef.current = false;
      return;
    }

    notifiedRef.current = false;
    poll();  // immediate first poll

    timerRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [sessionId, poll]);

  return { progress, error };
}


/**
 * useActiveTransfers
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls /api/transfer/active every 5 seconds to detect any ongoing transfers
 * (e.g. WiFi push from device that wasn't initiated from the UI).
 * Returns the list of active sessions.
 */
export function useActiveTransfers() {
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    const poll = async () => {
      try {
        const res  = await fetch("/api/transfer/active");
        if (res.ok) {
          const data = await res.json();
          setSessions(data);
        }
      } catch (_) {}
    };

    poll();
    const timer = setInterval(poll, 5000);
    return () => clearInterval(timer);
  }, []);

  return sessions;
}

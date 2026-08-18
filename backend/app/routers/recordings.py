from pathlib import Path
from uuid import UUID

import h5py
import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import Patient, Recording
from app.schemas import EcgWindow, RecordingRead
from app.storage.filesystem import FilesystemObjectStorage

router = APIRouter(prefix="/recordings", tags=["recordings"])
settings = get_settings()
storage = FilesystemObjectStorage(settings.object_storage_root)


class LocalRecordingRegister(BaseModel):
    patient_id: UUID
    object_key: str = Field(min_length=1, max_length=500)
    source_type: str = Field(default="local", max_length=30)


def _read_h5_metadata(path: Path) -> tuple[int, float, int, list[str]]:
    try:
        with h5py.File(path, "r") as handle:
            if "ecg" not in handle:
                raise ValueError("HDF5 object does not contain an 'ecg' dataset")
            dataset = handle["ecg"]
            if dataset.ndim != 2:
                raise ValueError("ECG dataset must be a 2-D [samples, leads] array")
            samples, leads = dataset.shape
            rate = float(handle.attrs.get("sampling_rate", 0))
            names = handle.attrs.get("lead_names", [])
            if isinstance(names, np.ndarray):
                names = [x.decode() if isinstance(x, bytes) else str(x) for x in names.tolist()]
            names = list(names) if names else [f"Lead {i + 1}" for i in range(leads)]
            return samples, rate, leads, names
    except OSError as exc:
        raise ValueError("Unable to read HDF5 recording") from exc


@router.post("/register-local", response_model=RecordingRead, status_code=201)
def register_local_recording(payload: LocalRecordingRegister, db: Session = Depends(get_db)):
    patient = db.get(Patient, payload.patient_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    path = storage.path_for(payload.object_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Recording object not found")
    try:
        samples, rate, leads, names = _read_h5_metadata(path)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    duration = samples / rate if rate > 0 else None
    recording = Recording(
        patient_id=patient.id,
        status="available",
        source_type=payload.source_type,
        duration_sec=duration,
        sampling_rate_hz=rate or None,
        lead_count=leads,
        lead_names=names,
        processed_object_key=payload.object_key,
    )
    db.add(recording)
    db.commit()
    db.refresh(recording)
    return recording


@router.get("/{recording_id}", response_model=RecordingRead)
def get_recording(recording_id: UUID, db: Session = Depends(get_db)):
    recording = db.get(Recording, recording_id)
    if not recording:
        raise HTTPException(status_code=404, detail="Recording not found")
    return recording


@router.get("/{recording_id}/ecg", response_model=EcgWindow)
def get_ecg_window(
    recording_id: UUID,
    start_sec: float = Query(default=0, ge=0),
    duration_sec: float = Query(default=10, gt=0, le=120),
    db: Session = Depends(get_db),
):
    recording = db.get(Recording, recording_id)
    if not recording or not recording.processed_object_key:
        raise HTTPException(status_code=404, detail="Recording data not found")
    if not recording.sampling_rate_hz or not recording.lead_count:
        raise HTTPException(status_code=422, detail="Recording metadata is incomplete")
    path = storage.path_for(recording.processed_object_key)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Recording object not found")

    start = int(start_sec * recording.sampling_rate_hz)
    count = int(duration_sec * recording.sampling_rate_hz)
    try:
        with h5py.File(path, "r") as handle:
            data = handle["ecg"]
            if start >= data.shape[0]:
                raise HTTPException(status_code=416, detail="start_sec exceeds recording duration")
            end = min(start + count, data.shape[0])
            window = np.asarray(data[start:end], dtype=np.float32)
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Unable to read recording") from exc

    return EcgWindow(
        patient_id=recording.patient_id,
        recording_id=recording.id,
        sampling_rate_hz=recording.sampling_rate_hz,
        lead_count=recording.lead_count,
        lead_names=recording.lead_names or [f"Lead {i + 1}" for i in range(recording.lead_count)],
        start_sec=start / recording.sampling_rate_hz,
        duration_sec=len(window) / recording.sampling_rate_hz,
        samples=window.tolist(),
    )

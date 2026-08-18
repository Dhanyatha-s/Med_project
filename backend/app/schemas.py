from datetime import date, datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field


class PatientCreate(BaseModel):
    patient_number: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    date_of_birth: date | None = None
    sex: str | None = Field(default=None, max_length=20)


class PatientUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=200)
    date_of_birth: date | None = None
    sex: str | None = Field(default=None, max_length=20)


class PatientRead(PatientCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    created_at: datetime
    updated_at: datetime

    @computed_field
    @property
    def age(self) -> int | None:
        if self.date_of_birth is None:
            return None
        today = date.today()
        return today.year - self.date_of_birth.year - ((today.month, today.day) < (self.date_of_birth.month, self.date_of_birth.day))


class RecordingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    patient_id: UUID
    status: str
    source_type: str | None
    started_at: datetime | None
    ended_at: datetime | None
    duration_sec: float | None
    sampling_rate_hz: float | None
    lead_count: int | None
    lead_names: list[str] | None
    raw_object_key: str | None
    processed_object_key: str | None
    checksum_sha256: str | None
    recording_metadata: dict | None
    created_at: datetime


class AnnotationCreate(BaseModel):
    recording_id: UUID | None = None
    timestamp_sec: float | None = Field(default=None, ge=0)
    annotation_type: str = Field(default="diary", max_length=30)
    note: str = Field(default="", max_length=4000)
    source: str = Field(default="doctor", max_length=30)


class AnnotationUpdate(BaseModel):
    timestamp_sec: float | None = Field(default=None, ge=0)
    annotation_type: str | None = Field(default=None, max_length=30)
    note: str | None = Field(default=None, max_length=4000)


class AnnotationRead(AnnotationCreate):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    patient_id: UUID
    created_at: datetime
    updated_at: datetime


class EcgWindow(BaseModel):
    patient_id: UUID
    recording_id: UUID
    sampling_rate_hz: float
    lead_count: int
    lead_names: list[str]
    start_sec: float
    duration_sec: float
    samples: list[list[float]]

from datetime import date, datetime
from uuid import UUID, uuid4

from sqlalchemy import Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base


class Patient(Base):
    __tablename__ = "patients"
    __table_args__ = (UniqueConstraint("patient_number", name="uq_patients_patient_number"),)

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    patient_number: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    date_of_birth: Mapped[date | None] = mapped_column(Date)
    sex: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    recordings: Mapped[list["Recording"]] = relationship(back_populates="patient", cascade="all, delete-orphan")
    annotations: Mapped[list["Annotation"]] = relationship(back_populates="patient", cascade="all, delete-orphan")


class Recording(Base):
    __tablename__ = "recordings"
    __table_args__ = (
        Index("ix_recordings_patient_created", "patient_id", "created_at"),
        Index("ix_recordings_status", "status"),
    )

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    patient_id: Mapped[UUID] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), nullable=False)
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="available")
    source_type: Mapped[str | None] = mapped_column(String(30))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_sec: Mapped[float | None] = mapped_column(Float)
    sampling_rate_hz: Mapped[float | None] = mapped_column(Float)
    lead_count: Mapped[int | None] = mapped_column(Integer)
    lead_names: Mapped[list[str] | None] = mapped_column(JSONB)
    raw_object_key: Mapped[str | None] = mapped_column(Text)
    processed_object_key: Mapped[str | None] = mapped_column(Text)
    checksum_sha256: Mapped[str | None] = mapped_column(String(64))
    recording_metadata: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    patient: Mapped[Patient] = relationship(back_populates="recordings")
    annotations: Mapped[list["Annotation"]] = relationship(back_populates="recording", cascade="all, delete-orphan")


class Annotation(Base):
    __tablename__ = "annotations"
    __table_args__ = (Index("ix_annotations_patient_time", "patient_id", "timestamp_sec"),)

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    patient_id: Mapped[UUID] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), nullable=False)
    recording_id: Mapped[UUID | None] = mapped_column(ForeignKey("recordings.id", ondelete="SET NULL"))
    timestamp_sec: Mapped[float | None] = mapped_column(Float)
    annotation_type: Mapped[str] = mapped_column(String(30), nullable=False, default="diary")
    note: Mapped[str] = mapped_column(Text, nullable=False, default="")
    source: Mapped[str] = mapped_column(String(30), nullable=False, default="doctor")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    patient: Mapped[Patient] = relationship(back_populates="annotations")
    recording: Mapped[Recording | None] = relationship(back_populates="annotations")


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (Index("ix_reports_patient_created", "patient_id", "created_at"),)

    id: Mapped[UUID] = mapped_column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)
    patient_id: Mapped[UUID] = mapped_column(ForeignKey("patients.id", ondelete="CASCADE"), nullable=False)
    recording_id: Mapped[UUID | None] = mapped_column(ForeignKey("recordings.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="draft")
    pdf_object_key: Mapped[str | None] = mapped_column(Text)
    signed_by: Mapped[str | None] = mapped_column(String(200))
    signed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)

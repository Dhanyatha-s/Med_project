"""Initial Phase 1 PostgreSQL schema.

Revision ID: 0001_initial_phase1
Revises:
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_initial_phase1"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "patients",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("patient_number", sa.String(64), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("date_of_birth", sa.Date(), nullable=True),
        sa.Column("sex", sa.String(20), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("patient_number", name="uq_patients_patient_number"),
    )
    op.create_index("ix_patients_patient_number", "patients", ["patient_number"])

    op.create_table(
        "recordings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("patient_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("patients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("source_type", sa.String(30)),
        sa.Column("started_at", sa.DateTime(timezone=True)),
        sa.Column("ended_at", sa.DateTime(timezone=True)),
        sa.Column("duration_sec", sa.Float()),
        sa.Column("sampling_rate_hz", sa.Float()),
        sa.Column("lead_count", sa.Integer()),
        sa.Column("lead_names", postgresql.JSONB()),
        sa.Column("raw_object_key", sa.Text()),
        sa.Column("processed_object_key", sa.Text()),
        sa.Column("checksum_sha256", sa.String(64)),
        sa.Column("recording_metadata", postgresql.JSONB()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_recordings_patient_created", "recordings", ["patient_id", "created_at"])
    op.create_index("ix_recordings_status", "recordings", ["status"])

    op.create_table(
        "annotations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("patient_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("patients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recording_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("recordings.id", ondelete="SET NULL")),
        sa.Column("timestamp_sec", sa.Float()),
        sa.Column("annotation_type", sa.String(30), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("source", sa.String(30), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_annotations_patient_time", "annotations", ["patient_id", "timestamp_sec"])

    op.create_table(
        "reports",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("patient_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("patients.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recording_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("recordings.id", ondelete="SET NULL")),
        sa.Column("status", sa.String(30), nullable=False),
        sa.Column("pdf_object_key", sa.Text()),
        sa.Column("signed_by", sa.String(200)),
        sa.Column("signed_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_reports_patient_created", "reports", ["patient_id", "created_at"])


def downgrade() -> None:
    op.drop_index("ix_reports_patient_created", table_name="reports")
    op.drop_table("reports")
    op.drop_index("ix_annotations_patient_time", table_name="annotations")
    op.drop_table("annotations")
    op.drop_index("ix_recordings_status", table_name="recordings")
    op.drop_index("ix_recordings_patient_created", table_name="recordings")
    op.drop_table("recordings")
    op.drop_index("ix_patients_patient_number", table_name="patients")
    op.drop_table("patients")

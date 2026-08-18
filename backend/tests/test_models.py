from app.models import Annotation, Patient, Recording, Report


def test_phase1_tables_are_defined() -> None:
    assert Patient.__tablename__ == "patients"
    assert Recording.__tablename__ == "recordings"
    assert Annotation.__tablename__ == "annotations"
    assert Report.__tablename__ == "reports"


def test_recording_keeps_large_data_out_of_postgres_rows() -> None:
    column_names = {column.name for column in Recording.__table__.columns}
    assert "raw_object_key" in column_names
    assert "processed_object_key" in column_names
    assert "recording_metadata" in column_names
    assert "ecg" not in column_names

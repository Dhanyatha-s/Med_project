from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Annotation, Patient, Recording
from app.schemas import AnnotationCreate, AnnotationRead, AnnotationUpdate

router = APIRouter(prefix="/patients/{patient_id}/annotations", tags=["annotations"])


def _patient_or_404(patient_id: UUID, db: Session) -> Patient:
    patient = db.get(Patient, patient_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    return patient


@router.get("", response_model=list[AnnotationRead])
def list_annotations(patient_id: UUID, db: Session = Depends(get_db)):
    _patient_or_404(patient_id, db)
    return db.scalars(
        select(Annotation)
        .where(Annotation.patient_id == patient_id)
        .order_by(Annotation.timestamp_sec.nulls_last(), Annotation.created_at)
    ).all()


@router.post("", response_model=AnnotationRead, status_code=status.HTTP_201_CREATED)
def create_annotation(patient_id: UUID, payload: AnnotationCreate, db: Session = Depends(get_db)):
    _patient_or_404(patient_id, db)
    if payload.recording_id is not None:
        recording = db.get(Recording, payload.recording_id)
        if not recording or recording.patient_id != patient_id:
            raise HTTPException(status_code=400, detail="recording_id does not belong to patient")
    annotation = Annotation(patient_id=patient_id, **payload.model_dump())
    db.add(annotation)
    db.commit()
    db.refresh(annotation)
    return annotation


@router.patch("/{annotation_id}", response_model=AnnotationRead)
def update_annotation(
    patient_id: UUID,
    annotation_id: UUID,
    payload: AnnotationUpdate,
    db: Session = Depends(get_db),
):
    annotation = db.scalar(
        select(Annotation).where(Annotation.id == annotation_id, Annotation.patient_id == patient_id)
    )
    if not annotation:
        raise HTTPException(status_code=404, detail="Annotation not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(annotation, key, value)
    db.commit()
    db.refresh(annotation)
    return annotation


@router.delete("/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(patient_id: UUID, annotation_id: UUID, db: Session = Depends(get_db)):
    annotation = db.scalar(
        select(Annotation).where(Annotation.id == annotation_id, Annotation.patient_id == patient_id)
    )
    if not annotation:
        raise HTTPException(status_code=404, detail="Annotation not found")
    db.delete(annotation)
    db.commit()

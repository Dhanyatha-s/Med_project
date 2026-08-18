# Holter ECG Platform

Commercial Holter ECG desktop platform under development for on-premise hospital/diagnostic-center deployment.

## Current engineering target

Phase 1 is being refactored around a clean FastAPI + PostgreSQL backend. The physical recorder/device acquisition layer is intentionally paused until the firmware/hardware team finalizes the recorder data contract.

### Phase 1 backend

```text
Electron (future desktop shell)
        |
        | HTTP/JSON on localhost or hospital LAN
        v
FastAPI
  |-- patients
  |-- recordings / ECG windows
  |-- annotations / diary
  |-- reports (domain model)
  |
  +--> PostgreSQL       metadata, workflow state, audit-ready records
  |
  +--> Object storage   ECG/HDF5 and generated files
       filesystem now; MinIO adapter later if multi-node deployment needs it
```

Large ECG arrays are not stored inside PostgreSQL. PostgreSQL stores metadata and object keys; HDF5/other object storage holds the signal data.

Authentication/RBAC is a planned project phase and is deliberately not mixed into this structural refactor.

## Development

From `backend/`:

```bash
python -m venv .venv
# Windows: .venv\\Scripts\\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API documentation: `http://127.0.0.1:8000/docs`

Run tests:

```bash
pytest -q
```

Database migrations:

```bash
alembic upgrade head
```

Set `HOLTER_DATABASE_URL` in `.env` for the local PostgreSQL instance.

## Important boundaries

- Device acquisition is not part of the current Phase 1 refactor.
- ML/clinical analysis is not part of this refactor; it will consume the stable recording contract later.
- The recorder must provide its finalized sampling rate, bit depth, gain, lead mapping, timestamps, transport/file format and packet semantics before the acquisition adapter and ML input contract are frozen.

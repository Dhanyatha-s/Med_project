from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import annotations, health, patients

settings = get_settings()

app = FastAPI(
    title=settings.app_name,
    version="0.1.0",
    description="On-premise Holter ECG application API. Acquisition is intentionally outside this Phase 1 refactor.",
)

# Electron/browser development needs local API access. In production this list
# should be narrowed to the actual Electron origin/server configuration.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix=settings.api_prefix)
app.include_router(patients.router, prefix=settings.api_prefix)
app.include_router(annotations.router, prefix=settings.api_prefix)


@app.get("/", tags=["system"])
def root() -> dict[str, str]:
    return {"service": settings.app_name, "docs": "/docs", "api": settings.api_prefix}

"""
report_generator.py  —  Clinical Holter ECG PDF Report Generator
─────────────────────────────────────────────────────────────────────────────
Pure ReportLab — no matplotlib, no external image dependencies.
ECG strips rendered as vector graphics directly on the PDF canvas.

H5 PATH FIX: h5_path passed in is always resolved to absolute before
opening. If it's relative, it's resolved against DATA_DIR from api.py.
Call: generate_report(..., h5_path=absolute_path, data_dir=DATA_DIR)

Report structure (7 sections):
  1. Cover page      — patient demographics + physician info + recording summary
  2. Summary cards   — 8 key measurements in a 2×4 card grid
  3. Arrhythmia table — 19 event types; counts show "—" until Phase 2
  4. ECG strips      — 6 representative 10s strips, vector-drawn
  5. HRV section     — SDNN, RMSSD live + pNN50/Triangular placeholder
  6. ST section      — placeholder per lead
  7. Doctor notes    — free-text + dual signature block

Usage:
    from report_generator import generate_report
    pdf_bytes = generate_report(
        patient_id   = "P001",
        patient      = {...},
        annotations  = [...],
        h5_path      = "/absolute/path/to/ecg.h5",   # or relative + data_dir
        data_dir     = DATA_DIR,                       # for path resolution
        profile      = {...},
        metrics      = {...},
        doctor_notes = "",
    )
"""

import io
import os
import datetime
import json

import h5py
import numpy as np

from reportlab.lib.pagesizes import A4
from reportlab.lib.units     import mm
from reportlab.lib           import colors
from reportlab.lib.styles    import ParagraphStyle
from reportlab.lib.enums     import TA_LEFT, TA_CENTER, TA_RIGHT
from reportlab.platypus      import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether, Flowable,
)

# ── Page geometry ─────────────────────────────────────────────────────────────
W, H  = A4
ML = MR = 15 * mm
MT      = 22 * mm
MB      = 20 * mm
CW      = W - ML - MR

# ── Colours ───────────────────────────────────────────────────────────────────
C_NAVY     = colors.HexColor("#1a237e")
C_BLUE     = colors.HexColor("#1565c0")
C_BLUE_L   = colors.HexColor("#e8edf7")
C_ACCENT   = colors.HexColor("#4f8ef7")
C_GREEN    = colors.HexColor("#1b5e20")
C_GREEN_L  = colors.HexColor("#e8f5e9")
C_AMBER    = colors.HexColor("#e65100")
C_AMBER_L  = colors.HexColor("#fff3e0")
C_RED      = colors.HexColor("#b71c1c")
C_RED_L    = colors.HexColor("#ffebee")
C_GREY     = colors.HexColor("#546e7a")
C_GREY_L   = colors.HexColor("#f5f5f5")
C_RULE     = colors.HexColor("#c5cae9")
C_PAPER    = colors.HexColor("#fdf6f0")
C_GRID_MIN = colors.HexColor("#e8c0b0")
C_GRID_MAJ = colors.HexColor("#d4806a")
C_TRACE    = colors.HexColor("#111010")
C_TEXT     = colors.HexColor("#212121")


# ── Styles ────────────────────────────────────────────────────────────────────
def _styles():
    s = {}

    def ps(name, **kw):
        return ParagraphStyle(name, **kw)

    s["title"]    = ps("title",    fontName="Helvetica-Bold",   fontSize=20, leading=26,
                        textColor=C_NAVY, alignment=TA_CENTER, spaceAfter=4)
    s["subtitle"] = ps("subtitle", fontName="Helvetica",        fontSize=11, leading=15,
                        textColor=C_GREY, alignment=TA_CENTER, spaceAfter=2)
    s["section"]  = ps("section",  fontName="Helvetica-Bold",   fontSize=11, leading=14,
                        textColor=C_NAVY, spaceBefore=12, spaceAfter=4)
    s["body"]     = ps("body",     fontName="Helvetica",        fontSize=9,  leading=13,
                        textColor=C_TEXT, spaceAfter=3)
    s["small"]    = ps("small",    fontName="Helvetica",        fontSize=8,  leading=11,
                        textColor=C_GREY)
    s["mono"]     = ps("mono",     fontName="Courier",          fontSize=8.5,leading=12,
                        textColor=colors.HexColor("#263238"))
    s["label"]    = ps("label",    fontName="Helvetica-Bold",   fontSize=8,  leading=10,
                        textColor=C_GREY)
    s["tbl_hdr"]  = ps("tbl_hdr",  fontName="Helvetica-Bold",   fontSize=8.5,leading=11,
                        textColor=C_NAVY)
    s["tbl_cell"] = ps("tbl_cell", fontName="Helvetica",        fontSize=8.5,leading=11,
                        textColor=C_TEXT)
    s["pending"]  = ps("pending",  fontName="Helvetica-Oblique",fontSize=8,  leading=10,
                        textColor=C_GREY)
    s["footer"]   = ps("footer",   fontName="Helvetica",        fontSize=7.5,leading=10,
                        textColor=C_GREY, alignment=TA_CENTER)
    s["note_text"]= ps("note_text",fontName="Helvetica-Oblique",fontSize=8.5,leading=12,
                        textColor=C_AMBER)
    return s


# ── ECG Strip Flowable ────────────────────────────────────────────────────────
class ECGStripFlowable(Flowable):
    """
    Draws one 10-second ECG strip as vector graphics directly on the PDF canvas.
    AHA clinical standard: warm-white paper, red 1mm/5mm grid, black trace,
    calibration pulse, isoelectric baseline, lead label, metadata strip.
    """
    MM_PER_SEC = 25
    MM_PER_MV  = 10

    def __init__(self, lead_name, samples, sr,
                 strip_w_mm=180, strip_h_mm=22, duration_sec=10):
        super().__init__()
        self.lead_name    = lead_name
        self.samples      = samples
        self.sr           = sr
        self.strip_w      = strip_w_mm * mm
        self.strip_h      = strip_h_mm * mm
        self.duration_sec = duration_sec
        self.width        = self.strip_w
        self.height       = self.strip_h + 2 * mm

    def draw(self):
        c = self.canv
        w = self.strip_w
        h = self.strip_h

        minor_pt = 1 * mm
        major_pt = 5 * mm
        px_per_s = self.MM_PER_SEC * mm
        px_per_mv= self.MM_PER_MV  * mm

        # Paper background
        c.setFillColor(C_PAPER)
        c.rect(0, 0, w, h, fill=1, stroke=0)

        # Minor grid (1mm)
        c.setStrokeColor(C_GRID_MIN)
        c.setLineWidth(0.3)
        p = c.beginPath()
        x = 0.0
        while x <= w + 0.01:
            p.moveTo(x, 0); p.lineTo(x, h); x += minor_pt
        y = 0.0
        while y <= h + 0.01:
            p.moveTo(0, y); p.lineTo(w, y); y += minor_pt
        c.drawPath(p)

        # Major grid (5mm)
        c.setStrokeColor(C_GRID_MAJ)
        c.setLineWidth(0.8)
        p = c.beginPath()
        x = 0.0
        while x <= w + 0.01:
            p.moveTo(x, 0); p.lineTo(x, h); x += major_pt
        y = 0.0
        while y <= h + 0.01:
            p.moveTo(0, y); p.lineTo(w, y); y += major_pt
        c.drawPath(p)

        # Border
        c.setStrokeColor(C_GRID_MAJ)
        c.setLineWidth(1.0)
        c.rect(0, 0, w, h, fill=0, stroke=1)

        center_y = h / 2

        # Calibration pulse: 10mm × 5mm (1 mV × 0.2 s)
        cal_w = 5 * mm
        cal_h = 10 * mm
        cal_x = 3 * minor_pt
        c.setStrokeColor(C_TRACE)
        c.setLineWidth(1.2)
        p = c.beginPath()
        p.moveTo(cal_x,         center_y + cal_h / 2)
        p.lineTo(cal_x,         center_y - cal_h / 2)
        p.lineTo(cal_x + cal_w, center_y - cal_h / 2)
        p.lineTo(cal_x + cal_w, center_y + cal_h / 2)
        c.drawPath(p)

        trace_x = cal_x + cal_w + 2 * minor_pt

        # Isoelectric baseline (dashed)
        c.setStrokeColor(colors.HexColor("#c0806080"))
        c.setLineWidth(0.5)
        c.setDash([2, 4])
        p = c.beginPath()
        p.moveTo(trace_x, center_y)
        p.lineTo(w - minor_pt, center_y)
        c.drawPath(p)
        c.setDash([])

        # Lead label
        c.setFillColor(colors.HexColor("#a82020"))
        c.setFont("Helvetica-Bold", 7)
        c.drawString(2 * minor_pt, h - 4 * mm, self.lead_name)

        # ECG trace
        buf = self.samples
        if buf is not None and len(buf) > 1:
            buf = np.array(buf, dtype=np.float32)

            # Isoelectric baseline — median of lowest 15%
            sorted_s = np.sort(buf)
            n15      = max(1, int(len(sorted_s) * 0.15))
            baseline = float(np.mean(sorted_s[:n15]))

            # Auto-gain: fit signal into 44% of strip height
            row_half_mv = (h * 0.44) / px_per_mv
            peak        = float(np.max(np.abs(buf - baseline)))
            gain_mult   = min(1.0, row_half_mv / peak) if peak > row_half_mv and peak > 0 else 1.0
            pvmv        = px_per_mv * gain_mult

            avail_w = w - trace_x - minor_pt
            n_pts   = min(len(buf), int((avail_w / px_per_s) * self.sr) + 1)

            c.setStrokeColor(C_TRACE)
            c.setLineWidth(1.0)
            c.setLineCap(1)
            p = c.beginPath()
            for i in range(n_pts):
                px = trace_x + (i / self.sr) * px_per_s
                py = center_y - (buf[i] - baseline) * pvmv
                if i == 0:
                    p.moveTo(px, py)
                else:
                    p.lineTo(px, py)
            c.drawPath(p)

            # Gain label
            c.setFillColor(colors.HexColor("#a82020"))
            c.setFont("Helvetica", 6)
            c.drawString(cal_x,
                         center_y - cal_h / 2 - 3 * mm,
                         f"{int(self.MM_PER_MV * gain_mult)} mm/mV")
        else:
            c.setFillColor(C_GREY)
            c.setFont("Helvetica-Oblique", 8)
            c.drawCentredString(w / 2, center_y, "No data available for this strip")

        # Bottom metadata strip
        c.setFillColor(C_GREY)
        c.setFont("Helvetica", 6)
        c.drawString(2 * minor_pt, 1.5 * mm,
                     f"25 mm/s  |  10 mm/mV  |  {self.duration_sec}s window")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _fmt_hms(sec) -> str:
    if sec is None:
        return "—"
    sec = int(sec)
    return f"{sec//3600:02d}:{(sec%3600)//60:02d}:{sec%60:02d}"


def _tbl(data, col_widths, repeat_rows=0, hdr_bg=None):
    """Build a styled Table with standard grid and alternating rows."""
    t = Table(data, colWidths=col_widths, repeatRows=repeat_rows)
    style = [
        ("GRID",          (0,0), (-1,-1), 0.4, C_RULE),
        ("TOPPADDING",    (0,0), (-1,-1), 5),
        ("BOTTOMPADDING", (0,0), (-1,-1), 5),
        ("LEFTPADDING",   (0,0), (-1,-1), 6),
        ("RIGHTPADDING",  (0,0), (-1,-1), 6),
        ("VALIGN",        (0,0), (-1,-1), "MIDDLE"),
        ("ROWBACKGROUNDS",(0,1), (-1,-1), [colors.white, C_GREY_L]),
    ]
    if hdr_bg:
        style.append(("BACKGROUND", (0,0), (-1,0), hdr_bg))
    t.setStyle(TableStyle(style))
    return t


# ── Section builders ──────────────────────────────────────────────────────────

def _cover_demog_table(patient, recording_meta, s):
    def row(label, value):
        return [Paragraph(label, s["label"]), Paragraph(str(value or "—"), s["body"])]

    left = Table([
        row("Patient ID",    patient.get("id")),
        row("Name",          patient.get("name")),
        row("Age / Sex",     f"{patient.get('age','—')} yrs · {patient.get('sex','—')}"),
        row("Date of Birth", patient.get("dob")),
        row("Recorded",      patient.get("created_at")),
    ], colWidths=[30*mm, 55*mm])

    right = Table([
        row("Duration",    recording_meta.get("duration_str")),
        row("Sample Rate", f"{recording_meta.get('sr', 250)} Hz"),
        row("Leads",       recording_meta.get("leads_str")),
        row("Storage",     recording_meta.get("method")),
        row("File Size",   recording_meta.get("file_size")),
    ], colWidths=[30*mm, 55*mm])

    outer = Table(
        [[Paragraph("PATIENT INFORMATION", s["tbl_hdr"]),
          Paragraph("RECORDING DETAILS",   s["tbl_hdr"])],
         [left, right]],
        colWidths=[CW/2, CW/2]
    )
    outer.setStyle(TableStyle([
        ("BACKGROUND",   (0,0), (-1,0), C_BLUE_L),
        ("GRID",         (0,0), (-1,-1), 0.5, C_RULE),
        ("TOPPADDING",   (0,0), (-1,-1), 6),
        ("BOTTOMPADDING",(0,0), (-1,-1), 6),
        ("LEFTPADDING",  (0,0), (-1,-1), 8),
        ("VALIGN",       (0,0), (-1,-1), "TOP"),
    ]))
    return outer


def _summary_cards(display_metrics, s):
    def card(title, value, unit, normal, warn=False):
        bg = C_AMBER_L if warn else C_BLUE_L
        vc = C_AMBER   if warn else C_NAVY
        inner = Table([
            [Paragraph(title, ParagraphStyle("ct", fontName="Helvetica-Bold",
                fontSize=7, textColor=C_NAVY))],
            [Paragraph(str(value), ParagraphStyle("cv", fontName="Helvetica-Bold",
                fontSize=18, leading=22, textColor=vc))],
            [Paragraph(unit,   ParagraphStyle("cu", fontName="Helvetica",
                fontSize=8, textColor=C_GREY))],
            [Paragraph(f"Normal: {normal}", ParagraphStyle("cr", fontName="Helvetica",
                fontSize=7, textColor=C_GREY))],
        ], colWidths=[CW/4 - 6*mm])
        inner.setStyle(TableStyle([
            ("BACKGROUND",    (0,0),(-1,-1), bg),
            ("TOPPADDING",    (0,0),(-1,-1), 5),
            ("BOTTOMPADDING", (0,0),(-1,-1), 5),
            ("LEFTPADDING",   (0,0),(-1,-1), 8),
        ]))
        return inner

    m   = display_metrics
    qtc_warn = False
    try:
        qtc_warn = float(str(m.get("qtc","0")).replace("ms","")) > 450
    except Exception:
        pass

    cards = [
        card("HEART RATE",   m.get("hr","—"),    "bpm", "60–100 bpm"),
        card("RR INTERVAL",  m.get("rr","—"),    "ms",  "600–1000 ms"),
        card("PR INTERVAL",  m.get("pr","—"),    "ms",  "120–200 ms"),
        card("QRS DURATION", m.get("qrs","—"),   "ms",  "60–100 ms"),
        card("QT INTERVAL",  m.get("qt","—"),    "ms",  "350–440 ms"),
        card("QTc (Bazett)", m.get("qtc","—"),   "ms",  "< 450 ms", warn=qtc_warn),
        card("SDNN (HRV)",   m.get("sdnn","—"),  "ms",  "50–100 ms"),
        card("RMSSD (HRV)",  m.get("rmssd","—"), "ms",  "20–50 ms"),
    ]
    cw  = CW / 4
    tbl = Table([cards[0:4], cards[4:8]], colWidths=[cw]*4)
    tbl.setStyle(TableStyle([
        ("GRID",          (0,0),(-1,-1), 0.5, C_RULE),
        ("TOPPADDING",    (0,0),(-1,-1), 0),
        ("BOTTOMPADDING", (0,0),(-1,-1), 0),
        ("LEFTPADDING",   (0,0),(-1,-1), 0),
        ("RIGHTPADDING",  (0,0),(-1,-1), 0),
    ]))
    return tbl


def _arrhythmia_table(s):
    EVENTS = [
        ("Atrial Fibrillation",       "Atrial",      "0 episodes"),
        ("Isolated Premature Beats",  "Atrial",      "< 100/day"),
        ("Premature Pairs",           "Atrial",      "0 pairs"),
        ("Atrial Bigeminy",           "Atrial",      "0 runs"),
        ("Atrial Trigeminy",          "Atrial",      "0 runs"),
        ("Atrial Runs (SVT)",         "Atrial",      "0 runs"),
        ("Short Pause (2–3s)",        "Atrial",      "< 5/day"),
        ("Long Pause (>3s)",          "Atrial",      "0 pauses"),
        ("Bradycardia (<50 bpm)",     "Atrial",      "0 episodes"),
        ("Tachycardia (>100 bpm)",    "Atrial",      "0 episodes"),
        ("Isolated Ectopic",          "Ventricular", "< 100/day"),
        ("Premature Ectopic (PVC)",   "Ventricular", "< 200/day"),
        ("Interpolated Ectopic",      "Ventricular", "0"),
        ("Late Ectopic",              "Ventricular", "0"),
        ("R-on-T Phenomenon",         "Ventricular", "0"),
        ("Ventricular Bigeminy",      "Ventricular", "0 runs"),
        ("Ventricular Trigeminy",     "Ventricular", "0 runs"),
        ("Ventricular Couplets",      "Ventricular", "0"),
        ("Ventricular Triplets/Runs", "Ventricular", "0"),
    ]
    hdr = [Paragraph(t, s["tbl_hdr"]) for t in
           ["#","Event Type","Category","Count","Duration","Normal Range","Status"]]
    rows = [hdr]
    for i, (name, cat, normal) in enumerate(EVENTS):
        rows.append([
            Paragraph(str(i+1),  s["tbl_cell"]),
            Paragraph(name,      s["tbl_cell"]),
            Paragraph(cat,       s["tbl_cell"]),
            Paragraph("—",       s["pending"]),
            Paragraph("—",       s["pending"]),
            Paragraph(normal,    s["small"]),
            Paragraph("Pending", s["pending"]),
        ])
    return _tbl(rows,
                [8*mm, 52*mm, 24*mm, 16*mm, 18*mm, 28*mm, 18*mm],
                repeat_rows=1, hdr_bg=C_BLUE_L)


def _ecg_strips(h5_path_abs, lead_names, sr, total_sec, s):
    story = []
    if not h5_path_abs or not os.path.exists(h5_path_abs):
        story.append(Paragraph(
            f"ECG strips unavailable — H5 file not found: {h5_path_abs}",
            s["small"]))
        return story

    positions  = [0.0, 0.10, 0.25, 0.50, 0.75, 0.90]
    strip_sec  = 10.0
    render_lead= "II" if "II" in lead_names else (lead_names[0] if lead_names else None)
    lead_idx   = lead_names.index(render_lead) if render_lead in lead_names else 0

    try:
        fh = h5py.File(h5_path_abs, "r")
    except Exception as e:
        story.append(Paragraph(f"Cannot open H5: {e}", s["small"]))
        return story

    for i, frac in enumerate(positions):
        start_s = int(frac * total_sec * sr)
        end_s   = min(start_s + int(strip_sec * sr), int(fh["ecg"].shape[0]))
        try:
            buf = fh["ecg"][start_s:end_s, lead_idx].astype(np.float32)
        except Exception:
            buf = None

        hdr   = Paragraph(
            f"Strip {i+1} — Lead {render_lead}  ·  T = {_fmt_hms(frac*total_sec)}"
            f"  ({int(frac*100)}% of recording)",
            s["section"])
        strip = ECGStripFlowable(render_lead, buf, sr,
                                  strip_w_mm=CW/mm, strip_h_mm=22,
                                  duration_sec=strip_sec)
        story.append(KeepTogether([hdr, strip, Spacer(1, 4*mm)]))

    fh.close()
    return story


def _diary_section(annotations, s):
    if not annotations:
        return [Paragraph("No diary entries recorded.", s["small"])]
    hdr = [Paragraph(t, s["tbl_hdr"]) for t in
           ["Time", "Type", "Source", "Note", "Created"]]
    rows = [hdr]
    for ann in annotations:
        ts = ann.get("timestamp_sec")
        rows.append([
            Paragraph(_fmt_hms(ts) if ts is not None else "—", s["tbl_cell"]),
            Paragraph(ann.get("type",   "diary"),               s["tbl_cell"]),
            Paragraph(ann.get("source", "—"),                   s["small"]),
            Paragraph(ann.get("note",   ""),                    s["tbl_cell"]),
            Paragraph(ann.get("created_at", "")[:16],           s["small"]),
        ])
    return [_tbl(rows, [22*mm, 18*mm, 18*mm, CW-80*mm, 22*mm],
                 repeat_rows=1, hdr_bg=C_BLUE_L)]


# ── Page header / footer ──────────────────────────────────────────────────────

def _page_cb(canvas, doc, patient, profile, report_date):
    canvas.saveState()
    hospital = (profile.get("hospital") or "Holter ECG System").upper()
    doctor   = profile.get("doctor")   or "Attending Physician"

    # Header
    canvas.setStrokeColor(C_RULE); canvas.setLineWidth(0.8)
    canvas.line(ML, H - 13*mm, W - MR, H - 13*mm)
    canvas.setFont("Helvetica-Bold", 8); canvas.setFillColor(C_NAVY)
    canvas.drawString(ML, H - 10*mm, hospital)
    canvas.setFont("Helvetica", 8); canvas.setFillColor(C_GREY)
    canvas.drawCentredString(W/2, H - 10*mm,
        f"{patient.get('name','—')}  ·  {patient.get('id','—')}  ·  Holter ECG Report")
    canvas.drawRightString(W - MR, H - 10*mm, report_date)

    # Footer
    canvas.line(ML, 13*mm, W - MR, 13*mm)
    canvas.setFont("Helvetica", 7.5); canvas.setFillColor(C_GREY)
    canvas.drawString(ML, 9*mm,
        f"Dr. {doctor}  ·  {profile.get('licenseNo','')}  ·  {hospital}")
    canvas.drawCentredString(W/2, 9*mm, "CONFIDENTIAL — For Clinical Use Only")
    canvas.drawRightString(W - MR, 9*mm, f"Page {doc.page}")
    canvas.restoreState()


# ── Main entry point ──────────────────────────────────────────────────────────

def generate_report(
    patient_id:   str,
    patient:      dict,
    annotations:  list,
    h5_path:      str | None,
    profile:      dict,
    data_dir:     str | None  = None,
    metrics:      dict | None = None,
    doctor_notes: str         = "",
) -> bytes:
    """
    Generate the full clinical PDF. Returns raw bytes.

    h5_path may be relative or absolute. If relative, it is resolved
    against data_dir. This is the production-safe path fix.
    """
    s           = _styles()
    buf         = io.BytesIO()
    report_date = datetime.datetime.now().strftime("%d %b %Y  %H:%M")

    # ── Resolve H5 path to absolute ─────────────────────────────────────────
    h5_path_abs = None
    if h5_path:
        if os.path.isabs(h5_path):
            h5_path_abs = h5_path
        elif data_dir:
            h5_path_abs = os.path.normpath(os.path.join(data_dir, h5_path))
        else:
            h5_path_abs = os.path.abspath(h5_path)

    # ── Recording metadata ───────────────────────────────────────────────────
    recording_meta = {"duration_str": "—", "sr": 250, "leads_str": "—",
                      "method": "H5 compressed", "file_size": "—"}
    lead_names  = []
    total_sec   = 0.0
    sr          = 250

    if h5_path_abs and os.path.exists(h5_path_abs):
        try:
            with h5py.File(h5_path_abs, "r") as fh:
                shape    = fh["ecg"].shape
                sr       = int(fh.attrs.get("sampling_rate", 250))
                n_cols   = shape[1]
                total_sec= shape[0] / sr
                hours    = total_sec / 3600

                raw_leads = fh.attrs.get("lead_names")
                if raw_leads:
                    try:
                        lead_names = (json.loads(raw_leads)
                                      if isinstance(raw_leads, str)
                                      else list(raw_leads))
                    except Exception:
                        lead_names = [f"Ch{i+1}" for i in range(n_cols)]
                else:
                    _STD = {
                        3:  ["I","II","V2"],
                        12: ["I","II","III","aVR","aVL","aVF",
                             "V1","V2","V3","V4","V5","V6"],
                    }
                    lead_names = _STD.get(n_cols, [f"Ch{i+1}" for i in range(n_cols)])

                size_mb = os.path.getsize(h5_path_abs) / (1024 * 1024)
                recording_meta = {
                    "duration_str": f"{int(hours)}h {int((hours%1)*60):02d}m",
                    "sr":           sr,
                    "leads_str":    f"{n_cols}-Lead  ·  {', '.join(lead_names)}",
                    "method":       "H5 compressed (Blosc+Zstd)",
                    "file_size":    f"{size_mb:.1f} MB",
                }
        except Exception as e:
            recording_meta["duration_str"] = f"Read error: {e}"

    # ── Metrics display ──────────────────────────────────────────────────────
    def _ms(v):
        if v is None or v == "—": return "—"
        try:    return str(int(float(v) * 1000))
        except: return str(v)

    m = metrics or {}
    dm = {
        "hr":    str(m.get("hr", "—")),
        "rr":    _ms(m.get("rr")),
        "pr":    _ms(m.get("pr")),
        "qrs":   _ms(m.get("qrs")),
        "qt":    _ms(m.get("qt")),
        "qtc":   _ms(m.get("qtc")),
        "sdnn":  _ms(m.get("sdnn")),
        "rmssd": _ms(m.get("rmssd")),
    }

    # ── Build document ───────────────────────────────────────────────────────
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=ML, rightMargin=MR,
        topMargin=MT, bottomMargin=MB,
        title=f"Holter ECG Report — {patient.get('name', patient_id)}",
        author=profile.get("doctor", ""),
        subject="Holter ECG Clinical Report",
    )

    def on_page(canvas, doc):
        _page_cb(canvas, doc, patient, profile, report_date)

    story = []

    # ── COVER ────────────────────────────────────────────────────────────────
    story += [
        Spacer(1, 8*mm),
        Paragraph((profile.get("hospital") or "Holter ECG System").upper(), s["title"]),
        Paragraph(profile.get("department") or "Cardiology", s["subtitle"]),
        Spacer(1, 2*mm),
        HRFlowable(width="80%", thickness=2, color=C_ACCENT, hAlign="CENTER"),
        Spacer(1, 2*mm),
        Paragraph("24 / 48 Hour Holter ECG Report", s["subtitle"]),
        Spacer(1, 6*mm),
        _cover_demog_table(patient, recording_meta, s),
        Spacer(1, 4*mm),
    ]

    # Phase 1 status banner
    banner = Table([[
        Paragraph("Report Generated",   s["label"]),
        Paragraph(report_date,          s["mono"]),
        Paragraph("Analysis Status",    s["label"]),
        Paragraph("Phase 1 — Measurements ready  ·  Arrhythmia detection: Phase 2",
                  s["note_text"]),
    ]], colWidths=[28*mm, 50*mm, 28*mm, CW-106*mm])
    banner.setStyle(TableStyle([
        ("BACKGROUND",    (0,0),(-1,-1), C_AMBER_L),
        ("GRID",          (0,0),(-1,-1), 0.4, C_RULE),
        ("TOPPADDING",    (0,0),(-1,-1), 6),
        ("BOTTOMPADDING", (0,0),(-1,-1), 6),
        ("LEFTPADDING",   (0,0),(-1,-1), 8),
    ]))
    story += [banner, PageBreak()]

    # ── SECTION 1: SUMMARY MEASUREMENTS ─────────────────────────────────────
    story += [
        Paragraph("1.  Summary Measurements", s["section"]),
        HRFlowable(width="100%", thickness=0.6, color=C_RULE),
        Spacer(1, 3*mm),
        _summary_cards(dm, s),
        Spacer(1, 6*mm),
        Paragraph("Heart Rate Variability (Time Domain)", s["section"]),
        HRFlowable(width="100%", thickness=0.4, color=C_RULE),
        Spacer(1, 2*mm),
    ]

    hrv_rows = [
        [Paragraph(t, s["tbl_hdr"]) for t in
         ["Metric","Value","Normal Range","Status"]],
        [Paragraph("SDNN",   s["tbl_cell"]),
         Paragraph(f"{dm['sdnn']} ms", s["tbl_cell"]),
         Paragraph("50–100 ms",  s["small"]),
         Paragraph("Measured",   s["small"])],
        [Paragraph("RMSSD",  s["tbl_cell"]),
         Paragraph(f"{dm['rmssd']} ms", s["tbl_cell"]),
         Paragraph("20–50 ms",   s["small"]),
         Paragraph("Measured",   s["small"])],
        [Paragraph("pNN50",  s["tbl_cell"]),
         Paragraph("Pending Phase 2", s["pending"]),
         Paragraph("> 3%",   s["small"]),
         Paragraph("—",      s["pending"])],
        [Paragraph("HRV Triangular Index", s["tbl_cell"]),
         Paragraph("Pending Phase 2", s["pending"]),
         Paragraph("> 15",   s["small"]),
         Paragraph("—",      s["pending"])],
    ]
    story += [
        _tbl(hrv_rows, [45*mm, 40*mm, 40*mm, CW-125*mm],
             repeat_rows=1, hdr_bg=C_BLUE_L),
        PageBreak(),
    ]

    # ── SECTION 2: ARRHYTHMIA EVENTS ─────────────────────────────────────────
    story += [
        Paragraph("2.  Arrhythmia Event Summary", s["section"]),
        HRFlowable(width="100%", thickness=0.6, color=C_RULE),
        Spacer(1, 1*mm),
        Paragraph("Event detection requires Phase 2 analysis engine.",
                  s["note_text"]),
        Spacer(1, 3*mm),
        _arrhythmia_table(s),
        PageBreak(),
    ]

    # ── SECTION 3: ECG STRIPS ────────────────────────────────────────────────
    story += [
        Paragraph("3.  Representative ECG Strips", s["section"]),
        HRFlowable(width="100%", thickness=0.6, color=C_RULE),
        Spacer(1, 2*mm),
    ]
    story += _ecg_strips(h5_path_abs, lead_names, sr, total_sec, s)
    story.append(PageBreak())

    # ── SECTION 4: ST ANALYSIS ───────────────────────────────────────────────
    story += [
        Paragraph("4.  ST Segment Analysis", s["section"]),
        HRFlowable(width="100%", thickness=0.6, color=C_RULE),
        Spacer(1, 2*mm),
        Paragraph("ST segment analysis will be populated by Phase 2 engine.",
                  s["note_text"]),
        Spacer(1, 4*mm),
    ]
    st_leads = lead_names[:3] if lead_names else ["Ch1", "Ch2", "Ch3"]
    st_hdr   = [Paragraph(t, s["tbl_hdr"]) for t in
                ["Lead","Max Elev. (mV)","Max Depr. (mV)",
                 "Elev. Events","Depr. Events","Status"]]
    st_rows  = [st_hdr]
    for lead in st_leads:
        st_rows.append([
            Paragraph(lead, s["tbl_cell"]),
            Paragraph("—",  s["pending"]),
            Paragraph("—",  s["pending"]),
            Paragraph("—",  s["pending"]),
            Paragraph("—",  s["pending"]),
            Paragraph("Pending", s["pending"]),
        ])
    story += [
        _tbl(st_rows, [18*mm,32*mm,32*mm,32*mm,32*mm,CW-146*mm],
             repeat_rows=1, hdr_bg=C_BLUE_L),
        PageBreak(),
    ]

    # ── SECTION 5: PATIENT DIARY ─────────────────────────────────────────────
    story += [
        Paragraph("5.  Patient Diary &amp; Annotations", s["section"]),
        HRFlowable(width="100%", thickness=0.6, color=C_RULE),
        Spacer(1, 2*mm),
    ]
    story += _diary_section(annotations, s)
    story.append(Spacer(1, 6*mm))

    # ── SECTION 6: DOCTOR NOTES + SIGNATURE ──────────────────────────────────
    story += [
        Paragraph("6.  Physician Notes &amp; Interpretation", s["section"]),
        HRFlowable(width="100%", thickness=0.6, color=C_RULE),
        Spacer(1, 3*mm),
    ]

    notes_text = doctor_notes.strip() or "[Physician notes to be completed]"
    notes_tbl  = Table([[Paragraph(notes_text, s["body"])]],
                       colWidths=[CW])
    notes_tbl.setStyle(TableStyle([
        ("BOX",          (0,0),(-1,-1), 0.8, C_RULE),
        ("TOPPADDING",   (0,0),(-1,-1), 12),
        ("BOTTOMPADDING",(0,0),(-1,-1), 40),
        ("LEFTPADDING",  (0,0),(-1,-1), 12),
        ("BACKGROUND",   (0,0),(-1,-1), colors.white),
    ]))
    story += [notes_tbl, Spacer(1, 8*mm)]

    # Signature block
    sig = Table([[
        Table([
            [Paragraph("Reporting Physician", s["label"])],
            [Spacer(1, 12*mm)],
            [Paragraph("_" * 32, s["mono"])],
            [Paragraph(f"Dr. {profile.get('doctor','')}  ·  "
                       f"{profile.get('licenseNo','')}", s["small"])],
            [Paragraph(f"{profile.get('department','')}  ·  "
                       f"{profile.get('hospital','')}", s["small"])],
        ]),
        Table([
            [Paragraph("Date &amp; Signature", s["label"])],
            [Spacer(1, 12*mm)],
            [Paragraph("_" * 20, s["mono"])],
            [Paragraph(report_date, s["small"])],
            [Paragraph("Official Stamp", s["small"])],
        ]),
    ]], colWidths=[CW/2, CW/2])
    sig.setStyle(TableStyle([
        ("TOPPADDING",  (0,0),(-1,-1), 6),
        ("LEFTPADDING", (0,0),(-1,-1), 8),
        ("VALIGN",      (0,0),(-1,-1), "TOP"),
    ]))
    story += [
        sig,
        Spacer(1, 8*mm),
        HRFlowable(width="100%", thickness=0.4, color=C_RULE),
        Spacer(1, 2*mm),
        Paragraph(
            "This report was generated by the Holter ECG Analysis System (Phase 1). "
            "Arrhythmia detection, ST analysis, and full HRV metrics require Phase 2 engine. "
            "For clinical use only — interpret under qualified cardiologist supervision.",
            s["footer"]
        ),
    ]

    # ── Build PDF ────────────────────────────────────────────────────────────
    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    result = buf.getvalue()
    buf.close()
    return result
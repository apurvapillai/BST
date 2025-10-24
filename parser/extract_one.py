import os
import shutil
import zipfile
import tempfile
import xml.etree.ElementTree as ET
from datetime import datetime
from typing import List, Optional, Dict, Any

from sqlalchemy.orm import Session

from db.connection import engine
from db.models import (
    Machine,
    Reel,
    SensitivitySet,
    Defect,
    ReferenceImage,
    InspectionPhase,
    Mask,
    RLMConfig,
    RLMPhase,
    RLMMonitoring,
)

# ---------------------------
# Configuration
# ---------------------------

MACHINE_NAME = "Press 5"

# Dashboard image roots
DASHBOARD_IMG_DIR = os.path.join("dashboard", "static", "images")
DEFECT_IMG_DIR = os.path.join(DASHBOARD_IMG_DIR, "defects")
REFERENCE_IMG_DIR = os.path.join(DASHBOARD_IMG_DIR, "reference")

# ---------------------------
# Helpers
# ---------------------------

def ensure_dirs():
    os.makedirs(DEFECT_IMG_DIR, exist_ok=True)
    os.makedirs(REFERENCE_IMG_DIR, exist_ok=True)


def parse_datetime(date_str: str, time_str: str) -> datetime:
    """
    Parse "YYYY-MM-DD" + "HH:MM:SS" into a datetime.
    """
    return datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M:%S")


def text_as_float(node: Optional[ET.Element]) -> Optional[float]:
    if node is None or node.text is None:
        return None
    try:
        return float(str(node.text).strip())
    except Exception:
        return None


def attr_as_float(node: Optional[ET.Element], attr: str) -> Optional[float]:
    if node is None:
        return None
    try:
        val = node.attrib.get(attr)
        return float(val) if val is not None and val != "" else None
    except Exception:
        return None


def safe_join_relpath(abs_path: str, static_root: str = "dashboard/static") -> str:
    """
    Return a path string suitable for Flask's url_for('static', filename=...).
    """
    return os.path.relpath(abs_path, start=static_root).replace("\\", "/")


def build_intervals(
    events: List[Dict[str, Any]],
    final_end_time: Optional[datetime],
    final_end_format: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """
    Given a list of events (each with time, format, and phase), return time-ranged intervals.
    Each event must have: {"phase": str, "time": datetime, "format": Optional[float], "refimgid": Optional[str]}
    Intervals are [this.time, next.time); last interval ends at final_end_time / final_end_format.
    """
    if not events:
        return []
    # Ensure chronological
    events_sorted = sorted(events, key=lambda e: e["time"])
    intervals = []
    for i, ev in enumerate(events_sorted):
        start_time = ev["time"]
        start_format = ev.get("format")
        refimgid = ev.get("refimgid")
        phase = ev.get("phase")
        if i + 1 < len(events_sorted):
            end_time = events_sorted[i + 1]["time"]
            end_format = events_sorted[i + 1].get("format")
        else:
            end_time = final_end_time
            end_format = final_end_format
        # Only keep valid intervals
        if end_time is None or end_time <= start_time:
            continue
        intervals.append(
            {
                "phase": phase,
                "start_time": start_time,
                "end_time": end_time,
                "start_format": start_format,
                "end_format": end_format,
                "refimgid": refimgid,
            }
        )
    return intervals


def dict_from_element(el: ET.Element) -> Dict[str, Any]:
    """
    Convert an XML element (1-level children) to a python dict capturing attributes & text.
    Useful to store RLM config/tolerances as JSON without overfitting to schema.
    """
    data: Dict[str, Any] = {"_tag": el.tag, "_attrs": dict(el.attrib)}
    children = []
    for child in el:
        children.append({"_tag": child.tag, "_attrs": dict(child.attrib), "_text": (child.text or "").strip()})
    if children:
        data["_children"] = children
    else:
        data["_text"] = (el.text or "").strip()
    return data


# ---------------------------
# Core
# ---------------------------

def extract_one(zip_path: str):
    """
    Extract a single report ZIP:
      - Parse report.xml
      - Insert Reel, SensitivitySet (only sId_mmx_stand), Defects (+copy images)
      - Save Reference Images (+copy)
      - Write InspectionPhase intervals from statusprotocol
      - Capture Masks (sId_mmx_noinsp + noinspection="true")
      - Parse RLM module (config, phases, monitoring)
    """
    ensure_dirs()
    tmp_dir = tempfile.mkdtemp(prefix="bst_")

    try:
        # 1) Unzip
        with zipfile.ZipFile(zip_path, "r") as zf:
            # report.xml path inside ZIP
            xml_name_candidates = [n for n in zf.namelist() if n.lower().endswith("report.xml")]
            if not xml_name_candidates:
                print(f"⚠️ No report.xml found in {zip_path}. Skipping.")
                return
            xml_name = xml_name_candidates[0]

            # Extract XML
            zf.extract(xml_name, tmp_dir)
            xml_path = os.path.join(tmp_dir, xml_name)

            # Extract all images to tmp (both defects and reference images)
            for member in zf.namelist():
                lower = member.lower()
                if lower.endswith(".jpg") or lower.endswith(".jpeg") or lower.endswith(".png"):
                    zf.extract(member, tmp_dir)

        # 2) Parse XML
        tree = ET.parse(xml_path)
        root = tree.getroot()

        # Order / job
        order_node = root.find("order")
        job_node = root.find("order/job")
        order_number = order_node.attrib.get("number") if order_node is not None else None
        job_name = job_node.attrib.get("name") if job_node is not None else None

        # Optional reel code (e.g., <reel id="r6">)
        reel_code = None
        if root.tag.endswith("reel"):  # handles optional namespaces too
            reel_code = root.attrib.get("id")
        else:
            # fallback: look for a descendant <reel> (in case other files differ)
            reel_node = root.find(".//reel")
            if reel_node is not None:
                reel_code = reel_node.attrib.get("id")

        # Whole-file format dims
        format_length = text_as_float(root.find("order/job/formatlength"))
        format_width = text_as_float(root.find("order/job/formatwidth"))

        # Production window and reel format edges
        reelstart_node = root.find("production/reelstart")
        reelend_node = root.find("production/reelend")
        reel_start = attr_as_float(reelstart_node, "format")
        reel_end = attr_as_float(reelend_node, "format")

        start_node = root.find("production/productiontime/start")
        end_node = root.find("production/productiontime/end")
        if start_node is None or end_node is None:
            raise ValueError("Missing production start/end nodes")

        time_start = parse_datetime(start_node.attrib["date"], start_node.attrib["time"])
        time_end = parse_datetime(end_node.attrib["date"], end_node.attrib["time"])

        # 3) DB: open session
        with Session(engine) as session:
            # Machine
            machine = session.query(Machine).filter_by(name=MACHINE_NAME).first()
            if not machine:
                raise ValueError(f"Machine {MACHINE_NAME} not found in DB")

            # Duplicate reel guard (include reel_code if present)
            existing_q = session.query(Reel).filter_by(
                machine_id=machine.machine_id,
                order_number=order_number,
                job_name=job_name,
                reel_start=reel_start,
                reel_end=reel_end,
                time_start=time_start,
                time_end=time_end,
            )
            candidates = existing_q.all()
            if candidates:
                print(f"⚠️ Reel already exists (machine={MACHINE_NAME}, order={order_number}, job={job_name}). Skipping insert.")
                return

            # Insert Reel
            reel = Reel(
                machine_id=machine.machine_id,
                reel_code=reel_code,
                order_number=order_number,
                job_name=job_name,
                reel_start=reel_start,
                reel_end=reel_end,
                time_start=time_start,
                time_end=time_end,
                format_length=format_length,
                format_width=format_width,
            )
            session.add(reel)
            session.commit()

            # ---------------------------
            # Sensitivity Sets (only sId_mmx_stand)
            # ---------------------------
            for sset in root.findall("inspection/sensitivitysets/set"):
                set_name = sset.attrib.get("id")
                if set_name != "sId_mmx_stand":
                    continue  # ignore non-standard here

                is_standard = (sset.attrib.get("standard") == "true")
                for val in sset.findall("value"):
                    defect_class = val.attrib.get("name")
                    warn = float(val.attrib.get("warnthres", "0") or 0)
                    text = (val.text or "").strip()
                    threshold = None if text.upper() == "INF" else float(text or 0)
                    session.add(
                        SensitivitySet(
                            reel_id=reel.reel_id,
                            set_name=set_name,
                            is_standard=is_standard,
                            defect_class=defect_class,
                            threshold_value=threshold,
                            warn_threshold=warn,
                        )
                    )

            # ---------------------------
            # Defects (+copy images)
            # ---------------------------
            for defect in root.findall(".//defect"):
                class_node = defect.find("class")
                class_name = class_node.attrib.get("name") if class_node is not None else None
                magnitude = float(class_node.attrib.get("magnitude", 0) or 0) if class_node is not None else 0.0
                severity = float(class_node.attrib.get("value", 0) or 0) if class_node is not None else 0.0

                defect_time = parse_datetime(defect.attrib["date"], defect.attrib["time"])
                format_position = float(defect.attrib.get("format", 0) or 0)

                # Image (if present)
                image_src_rel = None
                img_node = defect.find("image")
                if img_node is not None:
                    relative_path = img_node.attrib.get("src", "").replace("../", "").replace("\\", "/")
                    extracted_img_path = os.path.join(tmp_dir, relative_path)
                    if os.path.exists(extracted_img_path):
                        target_path = os.path.join(DEFECT_IMG_DIR, os.path.basename(extracted_img_path))
                        shutil.copy(extracted_img_path, target_path)
                        image_src_rel = safe_join_relpath(target_path)

                session.add(
                    Defect(
                        reel_id=reel.reel_id,
                        class_name=class_name,
                        magnitude_value=magnitude,
                        severity_value=severity,
                        defect_time=defect_time,
                        format_position=format_position,
                        image_src=image_src_rel,
                    )
                )

            # ---------------------------
            # Reference Images (+copy)
            # ---------------------------
            # Strategy:
            #   1) Prefer explicit XML nodes if present (common patterns tried below).
            #   2) Fallback: scan all extracted images for names containing "reference".
            # ---------------------------
            # Reference Images (+copy)
            # ---------------------------
            # Strategy:
            #   1) Prefer explicit XML nodes if present (common patterns tried below).
            #   2) Fallback: scan all extracted images for names containing "reference".
            # Map any (path) if XML exposes it.

            ref_entries = []

            # Try common XML structures for reference images
            for ref_node in root.findall(".//reference_images/*"):
                attrs = dict(ref_node.attrib)
                # Look for a path attribute (src, href, file, name)
                path = (
                    attrs.get("src")
                    or attrs.get("href")
                    or attrs.get("file")
                    or attrs.get("name")
                )
                if path:
                    ref_entries.append(
                        {
                            "path": path.replace("../", "").replace("\\", "/"),
                        }
                    )

            # If none found, best-effort filename scan
            if not ref_entries:
                # walk tmp_dir and pick files with "reference" keyword
                for root_dir, _, files in os.walk(tmp_dir):
                    for fn in files:
                        lower = fn.lower()
                        if lower.endswith((".jpg", ".jpeg", ".png")) and "reference" in lower:
                            rel = os.path.relpath(os.path.join(root_dir, fn), start=tmp_dir).replace("\\", "/")
                            ref_entries.append({"path": rel})

            # Copy and insert DB rows
            seen_ref_basenames = set()
            for ref in ref_entries:
                src_path = os.path.join(tmp_dir, ref["path"])
                if not os.path.exists(src_path):
                    continue
                basename = os.path.basename(src_path)
                # Avoid duplicate copies if multiple references point to same file
                if basename in seen_ref_basenames:
                    continue
                seen_ref_basenames.add(basename)

                target_path = os.path.join(REFERENCE_IMG_DIR, basename)
                shutil.copy(src_path, target_path)
                image_src_rel = safe_join_relpath(target_path)

                session.add(
                    ReferenceImage(
                        reel_id=reel.reel_id,
                        filename=basename,
                        image_src=image_src_rel,
                    )
                )


            # ---------------------------
            # Inspection statusprotocol → phases
            # ---------------------------
            status_events = []
            for st in root.findall("inspection/statusprotocol/*"):
                phase = st.tag  # inactive / active / learn / ...
                try:
                    start_time = parse_datetime(st.attrib["date"], st.attrib["time"])
                except Exception:
                    continue
                fmt = attr_as_float(st, "format")
                refimgid = st.attrib.get("refimgid")  # may exist on <active ...>
                status_events.append(
                    {
                        "phase": phase,
                        "time": start_time,
                        "format": fmt,
                        "refimgid": refimgid,
                    }
                )

            insp_intervals = build_intervals(status_events, final_end_time=time_end, final_end_format=reel_end)
            for iv in insp_intervals:
                session.add(
                    InspectionPhase(
                        reel_id=reel.reel_id,
                        phase=iv["phase"],
                        start_time=iv["start_time"],
                        end_time=iv["end_time"],
                        start_format=iv.get("start_format"),
                        end_format=iv.get("end_format"),
                        refimgid=iv.get("refimgid"),
                    )
                )

            # ---------------------------
            # Masks (sId_mmx_noinsp + noinspection=true)
            # ---------------------------
            for m in root.findall(".//masks//mask"):
                # Attributes may be directly on <mask> or nested under a <properties> node
                props = dict(m.attrib)
                prop_node = m.find(".//properties")
                if prop_node is not None:
                    props.update(prop_node.attrib)

                sensitivitysetid = props.get("sensitivitysetid")
                noinspection_str = props.get("noinspection", "false").lower()
                if not (sensitivitysetid == "sId_mmx_noinsp" and noinspection_str == "true"):
                    continue

                # Date/time can be on mask or properties
                date_str = props.get("date") or m.attrib.get("date")
                time_str = props.get("time") or m.attrib.get("time")
                ts = None
                if date_str and time_str:
                    try:
                        ts = parse_datetime(date_str, time_str)
                    except Exception:
                        pass

                coords = props.get("coords") or ""
                fmt_val = None
                try:
                    fmt_val = float(props.get("format", "") or 0)
                except Exception:
                    pass

                session.add(
                    Mask(
                        reel_id=reel.reel_id,
                        xml_id=props.get("id") or m.attrib.get("id"),
                        sensitivitysetid=sensitivitysetid,
                        noinspection=True,
                        coords=coords,
                        timestamp=ts,
                        format_value=fmt_val,
                    )
                )

            # ---------------------------
            # RLM module (repeat length monitoring)
            # ---------------------------
            rlm = root.find(".//rlmmodule")
            if rlm is not None:
                # 1) Config/tolerances → JSON
                #    Collect immediate children (like <tolerances>…</tolerances>) into a dict-of-structs.
                cfg: Dict[str, Any] = {"_tag": rlm.tag, "_attrs": dict(rlm.attrib)}
                for child in rlm:
                    # Only 1-level-deep structure capture for robustness
                    cfg[child.tag] = dict_from_element(child)
                session.add(RLMConfig(reel_id=reel.reel_id, config_json=cfg))

                # 2) Phases inside RLM (pattern similar to statusprotocol)
                rlm_status_events = []
                for st in rlm.findall(".//statusprotocol/*"):
                    phase = st.tag
                    try:
                        start_time = parse_datetime(st.attrib["date"], st.attrib["time"])
                    except Exception:
                        continue
                    fmt = attr_as_float(st, "format")
                    rlm_status_events.append(
                        {"phase": phase, "time": start_time, "format": fmt}
                    )

                rlm_intervals = build_intervals(rlm_status_events, final_end_time=time_end, final_end_format=reel_end)
                for iv in rlm_intervals:
                    session.add(
                        RLMPhase(
                            reel_id=reel.reel_id,
                            phase=iv["phase"],
                            start_time=iv["start_time"],
                            end_time=iv["end_time"],
                            start_format=iv.get("start_format"),
                            end_format=iv.get("end_format"),
                        )
                    )


                # Your XML uses <monitorings><monpoint .../></monitorings>
                for mon in rlm.findall(".//monitorings/*"):         # catches <monpoint .../> and any variants under <monitorings>
                    _insert_rlm_monitor_if_possible(mon, session, reel.reel_id)


            # Commit everything
            session.commit()
            print(f"✅ Inserted Reel {reel.reel_id} ({order_number}/{job_name}) and all related data.")

    except Exception as e:
        print(f"❌ Failed on {zip_path}: {e}")
        raise
    finally:
        # Cleanup
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def _insert_rlm_monitor_if_possible(node: ET.Element, session: Session, reel_id: int):
    """
    Best-effort parse and insert one RLMMonitoring row from a monitoring-like XML node.
    Expects attributes: date, time, and (curlength | currentlength | cl), (webspeed | speed | ws)
    """
    attrs = node.attrib
    date_str = attrs.get("date")
    time_str = attrs.get("time")
    if not (date_str and time_str):
        return

    try:
        ts = parse_datetime(date_str, time_str)
    except Exception:
        return

    def _first_float(*keys) -> Optional[float]:
        for k in keys:
            if k in attrs and attrs[k] not in (None, ""):
                try:
                    return float(attrs[k])
                except Exception:
                    continue
        return None

    curlength = _first_float("curlength", "currentlength", "cl")
    webspeed = _first_float("webspeed", "speed", "ws")

    session.add(
        RLMMonitoring(
            reel_id=reel_id,
            timestamp=ts,
            curlength=curlength,
            webspeed=webspeed,
        )
    )


if __name__ == "__main__":
    # Local quick test (adjust path as needed)
    test_file = "data/2025-09-16_23-32_903286_11.zip"
    extract_one(test_file)

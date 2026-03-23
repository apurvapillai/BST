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

# Flask static root
STATIC_ROOT = os.path.join("dashboard", "static")
# Images live under: dashboard/static/images/<machine_name>/<YYYY-MM-DD>/{defects,reference}/...
DASHBOARD_IMG_DIR = os.path.join(STATIC_ROOT, "images")


def _ensure_day_dirs(machine_name: str, date_str: str) -> Dict[str, str]:
    """
    Ensure and return per-machine, per-day folders for image saving.
    Returns absolute paths: {"defects": <path>, "reference": <path>}
    """
    base_dir = os.path.join(DASHBOARD_IMG_DIR, machine_name, date_str)
    defect_dir = os.path.join(base_dir, "defects")
    reference_dir = os.path.join(base_dir, "reference")
    os.makedirs(defect_dir, exist_ok=True)
    os.makedirs(reference_dir, exist_ok=True)
    return {"defects": defect_dir, "reference": reference_dir}


def parse_datetime(date_str: str, time_str: str) -> datetime:
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


def parse_float_list(text: Optional[str]) -> Optional[List[float]]:
    if not text:
        return None
    floats: List[float] = []
    for token in text.replace(";", ",").replace("\n", ",").split(","):
        val = token.strip()
        if not val:
            continue
        try:
            floats.append(float(val))
        except Exception:
            continue
    return floats or None


def safe_join_relpath(abs_path: str, static_root: str = STATIC_ROOT) -> str:
    return os.path.relpath(abs_path, start=static_root).replace("\\", "/")


def build_intervals(
    events: List[Dict[str, Any]],
    final_end_time: Optional[datetime],
    final_end_format: Optional[float] = None,
) -> List[Dict[str, Any]]:
    if not events:
        return []
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
    data: Dict[str, Any] = {"_tag": el.tag, "_attrs": dict(el.attrib)}
    children = []
    for child in el:
        children.append(
            {"_tag": child.tag, "_attrs": dict(child.attrib), "_text": (child.text or "").strip()}
        )
    if children:
        data["_children"] = children
    else:
        data["_text"] = (el.text or "").strip()
    return data


def extract_one(zip_path: str, machine_name: str):
    """
    Extract one report ZIP for a specific machine.
    """
    tmp_dir = tempfile.mkdtemp(prefix="bst_")

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            xml_name_candidates = [n for n in zf.namelist() if n.lower().endswith("report.xml")]
            if not xml_name_candidates:
                print(f"⚠️ No report.xml found in {zip_path}. Skipping.")
                return

            xml_name = xml_name_candidates[0]
            zf.extract(xml_name, tmp_dir)
            xml_path = os.path.join(tmp_dir, xml_name)

            for member in zf.namelist():
                lower = member.lower()
                if lower.endswith(".jpg") or lower.endswith(".jpeg") or lower.endswith(".png"):
                    zf.extract(member, tmp_dir)

        tree = ET.parse(xml_path)
        root = tree.getroot()

        order_node = root.find("order")
        job_node = root.find("order/job")
        order_number = order_node.attrib.get("number") if order_node is not None else None
        job_name = job_node.attrib.get("name") if job_node is not None else None

        reel_code = None
        if root.tag.endswith("reel"):
            reel_code = root.attrib.get("id")
        else:
            reel_node = root.find(".//reel")
            if reel_node is not None:
                reel_code = reel_node.attrib.get("id")

        format_length = text_as_float(root.find("order/job/formatlength"))
        format_width = text_as_float(root.find("order/job/formatwidth"))

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

        with Session(engine) as session:
            machine = session.query(Machine).filter_by(name=machine_name).first()
            if not machine:
                raise ValueError(f"Machine {machine_name} not found in DB")

            exists = session.query(Reel).filter_by(
                machine_id=machine.machine_id,
                order_number=order_number,
                job_name=job_name,
                reel_start=reel_start,
                reel_end=reel_end,
                time_start=time_start,
                time_end=time_end,
            ).first()
            if exists:
                print(
                    f"⚠️ Reel already exists (machine={machine_name}, order={order_number}, job={job_name}). Skipping insert."
                )
                return

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

            date_str = time_start.strftime("%Y-%m-%d")
            img_dirs = _ensure_day_dirs(machine_name, date_str)
            DEFECT_IMG_DIR = img_dirs["defects"]
            REFERENCE_IMG_DIR = img_dirs["reference"]

            for sset in root.findall("inspection/sensitivitysets/set"):
                set_name = sset.attrib.get("id")
                if set_name != "sId_mmx_stand":
                    continue

                is_standard = sset.attrib.get("standard") == "true"
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

            for defect in root.findall(".//defect"):
                class_node = defect.find("class")
                class_name = class_node.attrib.get("name") if class_node is not None else None
                magnitude = float(class_node.attrib.get("magnitude", 0) or 0) if class_node is not None else 0.0
                severity = float(class_node.attrib.get("value", 0) or 0) if class_node is not None else 0.0

                defect_time = parse_datetime(defect.attrib["date"], defect.attrib["time"])
                format_position = float(defect.attrib.get("format", 0) or 0)

                image_src_rel = None
                img_node = defect.find("image")
                if img_node is not None:
                    relative_path = img_node.attrib.get("src", "").replace("../", "").replace("\\", "/")
                    extracted_img_path = os.path.join(tmp_dir, relative_path)
                    if os.path.exists(extracted_img_path):
                        target_path = os.path.join(DEFECT_IMG_DIR, os.path.basename(extracted_img_path))
                        shutil.copy(extracted_img_path, target_path)
                        image_src_rel = safe_join_relpath(target_path)

                coords_payload: List[Dict[str, Optional[List[float]]]] = []
                for pd_node in defect.findall(".//pds/pd"):
                    x_vals = parse_float_list(pd_node.findtext("x"))
                    y_vals = parse_float_list(pd_node.findtext("y"))
                    if not x_vals and not y_vals:
                        continue
                    coords_payload.append({"x": x_vals, "y": y_vals})
                coords_value = coords_payload or None

                session.add(
                    Defect(
                        reel_id=reel.reel_id,
                        class_name=class_name,
                        magnitude_value=magnitude,
                        severity_value=severity,
                        defect_time=defect_time,
                        format_position=format_position,
                        image_src=image_src_rel,
                        coords_json=coords_value,
                    )
                )

            ref_entries: List[Dict[str, str]] = []

            for ref_node in root.findall(".//reference_images/*"):
                attrs = dict(ref_node.attrib)
                path = attrs.get("src") or attrs.get("href") or attrs.get("file") or attrs.get("name")
                if path:
                    ref_entries.append({"path": path.replace("../", "").replace("\\", "/")})

            if not ref_entries:
                for root_dir, _, files in os.walk(tmp_dir):
                    for fn in files:
                        lower = fn.lower()
                        if lower.endswith((".jpg", ".jpeg", ".png")) and "reference" in lower:
                            rel = os.path.relpath(os.path.join(root_dir, fn), start=tmp_dir).replace("\\", "/")
                            ref_entries.append({"path": rel})

            seen_ref_basenames = set()
            for ref in ref_entries:
                src_path = os.path.join(tmp_dir, ref["path"])
                if not os.path.exists(src_path):
                    continue
                basename = os.path.basename(src_path)
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

            status_events = []
            for st in root.findall("inspection/statusprotocol/*"):
                phase = st.tag
                try:
                    start_time = parse_datetime(st.attrib["date"], st.attrib["time"])
                except Exception:
                    continue
                fmt = attr_as_float(st, "format")
                refimgid = st.attrib.get("refimgid")
                status_events.append(
                    {"phase": phase, "time": start_time, "format": fmt, "refimgid": refimgid}
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

            for m in root.findall(".//masks//mask"):
                props = dict(m.attrib)
                prop_node = m.find(".//properties")
                if prop_node is not None:
                    props.update(prop_node.attrib)

                sensitivitysetid = props.get("sensitivitysetid")
                noinspection_str = props.get("noinspection", "false").lower()
                if not (sensitivitysetid == "sId_mmx_noinsp" and noinspection_str == "true"):
                    continue

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

            rlm = root.find(".//rlmmodule")
            if rlm is not None:
                cfg: Dict[str, Any] = {"_tag": rlm.tag, "_attrs": dict(rlm.attrib)}
                for child in rlm:
                    cfg[child.tag] = dict_from_element(child)
                session.add(RLMConfig(reel_id=reel.reel_id, config_json=cfg))

                rlm_status_events = []
                for st in rlm.findall(".//statusprotocol/*"):
                    phase = st.tag
                    try:
                        start_time = parse_datetime(st.attrib["date"], st.attrib["time"])
                    except Exception:
                        continue
                    fmt = attr_as_float(st, "format")
                    rlm_status_events.append({"phase": phase, "time": start_time, "format": fmt})

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

                for mon in rlm.findall(".//monitorings/*"):
                    _insert_rlm_monitor_if_possible(mon, session, reel.reel_id)

            session.commit()
            print(f"✅ Inserted Reel {reel.reel_id} ({machine_name}: {order_number}/{job_name}) and all related data.")

    except Exception as e:
        print(f"❌ Failed on {zip_path} for {machine_name}: {e}")
        raise
    finally:
        try:
            shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception:
            pass


def _insert_rlm_monitor_if_possible(node: ET.Element, session: Session, reel_id: int):
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

    if curlength is None and webspeed is None:
        return

    session.add(
        RLMMonitoring(
            reel_id=reel_id,
            timestamp=ts,
            curlength=curlength,
            webspeed=webspeed,
        )
    )


if __name__ == "__main__":
    test_file = "data/Press 5/2025-09-16_23-32_903286_11.zip"
    extract_one(test_file, "Press 5")
import os
import shutil
import zipfile
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
)

# Flask static root
STATIC_ROOT = os.path.join("dashboard", "static")
# Images live under: dashboard/static/images/<machine_name>/<YYYY-MM-DD>/{defects,reference}/...
DASHBOARD_IMG_DIR = os.path.join(STATIC_ROOT, "images")
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")
_MACHINE_ID_CACHE: Dict[str, int] = {}


def _ensure_day_dirs(
    machine_name: str,
    date_str: str,
    include_defects: bool = True,
    include_reference: bool = True,
) -> Dict[str, str]:
    """
    Ensure and return per-machine, per-day folders for image saving.
    Returns absolute paths for requested image kinds.
    """
    base_dir = os.path.join(DASHBOARD_IMG_DIR, machine_name, date_str)
    defect_dir = os.path.join(base_dir, "defects")
    reference_dir = os.path.join(base_dir, "reference")
    paths: Dict[str, str] = {}
    if include_defects:
        os.makedirs(defect_dir, exist_ok=True)
        paths["defects"] = defect_dir
    if include_reference:
        os.makedirs(reference_dir, exist_ok=True)
        paths["reference"] = reference_dir
    return paths


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


def normalize_zip_image_path(path: Optional[str]) -> str:
    if not path:
        return ""
    cleaned = str(path).replace("\\", "/").strip()
    while cleaned.startswith("../"):
        cleaned = cleaned[3:]
    cleaned = cleaned.lstrip("/")
    return "/".join(part for part in cleaned.split("/") if part not in {"", "."})


def build_image_member_index(members: List[str]) -> Dict[str, str]:
    index: Dict[str, str] = {}
    for member in members:
        normalized = normalize_zip_image_path(member)
        if normalized.lower().endswith(IMAGE_EXTENSIONS):
            index[normalized] = member
    return index


def find_image_member(image_members: Dict[str, str], path: Optional[str]) -> Optional[str]:
    normalized = normalize_zip_image_path(path)
    if not normalized:
        return None
    if normalized in image_members:
        return image_members[normalized]

    basename = os.path.basename(normalized).lower()
    matches = [
        member
        for member_path, member in image_members.items()
        if os.path.basename(member_path).lower() == basename
    ]
    if len(matches) == 1:
        return matches[0]

    for member_path, member in image_members.items():
        if member_path.endswith(f"/{normalized}"):
            return member
    return None


def unique_filename(basename: str, used: set) -> str:
    candidate = basename
    stem, ext = os.path.splitext(basename)
    counter = 2
    while candidate in used:
        candidate = f"{stem}_{counter}{ext}"
        counter += 1
    used.add(candidate)
    return candidate


def copy_zip_image(
    zf: zipfile.ZipFile,
    member: str,
    target_dir: str,
    target_basename: Optional[str] = None,
) -> Optional[str]:
    basename = target_basename or os.path.basename(normalize_zip_image_path(member))
    basename = os.path.basename(basename)
    if not basename:
        return None
    os.makedirs(target_dir, exist_ok=True)
    target_path = os.path.join(target_dir, basename)
    with zf.open(member, "r") as source, open(target_path, "wb") as target:
        shutil.copyfileobj(source, target)
    return target_path


def build_intervals(
    events: List[Dict[str, Any]],
    final_end_time: Optional[datetime],
    final_end_format: Optional[float] = None,
) -> List[Dict[str, Any]]:
    if not events:
        return []

    events_sorted = sorted(events, key=lambda e: e["time"])
    intervals: List[Dict[str, Any]] = []

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


def mask_removal_event(mask_node: ET.Element, reel_id: int) -> Optional[Mask]:
    props = dict(mask_node.attrib)
    properties_node = mask_node.find(".//properties")
    if properties_node is not None:
        props.update(properties_node.attrib)
    if (
        props.get("sensitivitysetid") != "sId_mmx_noinsp"
        or props.get("noinspection", "false").lower() != "true"
    ):
        return None

    end_node = mask_node.find("end")
    if end_node is None:
        return None

    end_ts = None
    end_date = end_node.attrib.get("date")
    end_time = end_node.attrib.get("time")
    if end_date and end_time:
        try:
            end_ts = parse_datetime(end_date, end_time)
        except ValueError:
            pass

    end_format = attr_as_float(end_node, "format")
    if end_ts is None and end_format is None:
        return None

    return Mask(
        reel_id=reel_id,
        xml_id=props.get("id") or mask_node.attrib.get("id"),
        sensitivitysetid=props.get("sensitivitysetid"),
        noinspection=False,
        coords=props.get("coords") or "",
        timestamp=end_ts,
        format_value=end_format,
    )


def extract_one(
    zip_path: str,
    machine_name: str,
    save_images: bool = True,
    import_mode: str = "full",
    save_defect_images: Optional[bool] = None,
    save_reference_images: Optional[bool] = None,
):
    """
    Extract one report ZIP for a specific machine.

    Modes:
      - import_mode="full":
          imports all supported BST data
      - import_mode="data_only":
          imports all supported BST data; image capture is controlled separately
      - import_mode="minimal":
          imports only Reel + InspectionPhase

    Image capture:
      - save_reference_images controls reference image files and ReferenceImage rows
      - save_defect_images controls defect image files and Defect.image_src
      - save_images is kept for older callers; explicit image flags override it
    """
    if import_mode not in {"full", "data_only", "minimal"}:
        raise ValueError(f"Unsupported import_mode: {import_mode}")

    if save_defect_images is None:
        effective_save_defect_images = bool(save_images and import_mode == "full")
    else:
        effective_save_defect_images = bool(save_defect_images and import_mode != "minimal")

    if save_reference_images is None:
        effective_save_reference_images = bool(save_images and import_mode == "full")
    else:
        effective_save_reference_images = bool(save_reference_images and import_mode != "minimal")

    needs_image_zip = effective_save_defect_images or effective_save_reference_images
    image_zf: Optional[zipfile.ZipFile] = None

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            zip_members = zf.namelist()
            image_members = build_image_member_index(zip_members) if needs_image_zip else {}
            xml_name_candidates = [n for n in zip_members if n.lower().endswith("report.xml")]
            if not xml_name_candidates:
                print(f"⚠️ No report.xml found in {zip_path}. Skipping.")
                return

            xml_name = xml_name_candidates[0]
            with zf.open(xml_name, "r") as xml_file:
                tree = ET.parse(xml_file)
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
            machine_id = _MACHINE_ID_CACHE.get(machine_name)
            if machine_id is None:
                machine_id = session.query(Machine.machine_id).filter_by(name=machine_name).scalar()
                if machine_id is not None:
                    _MACHINE_ID_CACHE[machine_name] = int(machine_id)
            if machine_id is None:
                raise ValueError(f"Machine {machine_name} not found in DB")

            exists = session.query(Reel).filter_by(
                machine_id=machine_id,
                order_number=order_number,
                job_name=job_name,
                reel_start=reel_start,
                reel_end=reel_end,
                time_start=time_start,
                time_end=time_end,
            ).first()
            if exists:
                added_removals = 0
                for mask_node in root.findall(".//masks//mask"):
                    removal = mask_removal_event(mask_node, exists.reel_id)
                    if removal is None:
                        continue
                    existing_removal = (
                        session.query(Mask.mask_id)
                        .filter_by(
                            reel_id=removal.reel_id,
                            xml_id=removal.xml_id,
                            sensitivitysetid=removal.sensitivitysetid,
                            noinspection=False,
                            coords=removal.coords,
                            timestamp=removal.timestamp,
                            format_value=removal.format_value,
                        )
                        .first()
                    )
                    if existing_removal is None:
                        session.add(removal)
                        added_removals += 1
                if added_removals:
                    session.commit()
                print(
                    f"⚠️ Reel already exists (machine={machine_name}, order={order_number}, job={job_name}). "
                    f"Added {added_removals} mask removal event(s); skipped duplicate import."
                )
                return

            reel = Reel(
                machine_id=machine_id,
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
            session.flush()  # gets reel_id without committing early

            defect_img_dir: Optional[str] = None
            reference_img_dir: Optional[str] = None
            if effective_save_defect_images or effective_save_reference_images:
                image_zf = zipfile.ZipFile(zip_path, "r")
                date_str = time_start.strftime("%Y-%m-%d")
                img_dirs = _ensure_day_dirs(
                    machine_name,
                    date_str,
                    include_defects=effective_save_defect_images,
                    include_reference=effective_save_reference_images,
                )
                if effective_save_defect_images:
                    defect_img_dir = img_dirs["defects"]
                if effective_save_reference_images:
                    reference_img_dir = img_dirs["reference"]

            # Always build inspection phases, even in minimal mode
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

            insp_intervals = build_intervals(
                status_events,
                final_end_time=time_end,
                final_end_format=reel_end,
            )
            inspection_rows = []
            for iv in insp_intervals:
                inspection_rows.append(
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
            if inspection_rows:
                session.bulk_save_objects(inspection_rows)

            # Minimal mode stops here
            if import_mode == "minimal":
                session.commit()
                print(
                    f"✅ Inserted Reel {reel.reel_id} ({machine_name}: {order_number}/{job_name}) "
                    f"with InspectionPhase only. import_mode=minimal"
                )
                return

            # -------------------------
            # BST data modes below
            # -------------------------

            sensitivity_rows = []
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
                    sensitivity_rows.append(
                        SensitivitySet(
                            reel_id=reel.reel_id,
                            set_name=set_name,
                            is_standard=is_standard,
                            defect_class=defect_class,
                            threshold_value=threshold,
                            warn_threshold=warn,
                        )
                    )
            if sensitivity_rows:
                session.bulk_save_objects(sensitivity_rows)

            defect_rows = []
            for defect in root.findall(".//defect"):
                class_node = defect.find("class")
                class_name = class_node.attrib.get("name") if class_node is not None else None
                magnitude = (
                    float(class_node.attrib.get("magnitude", 0) or 0)
                    if class_node is not None
                    else 0.0
                )
                severity = (
                    float(class_node.attrib.get("value", 0) or 0)
                    if class_node is not None
                    else 0.0
                )

                defect_time = parse_datetime(defect.attrib["date"], defect.attrib["time"])
                format_position = float(defect.attrib.get("format", 0) or 0)

                image_src_rel = None
                if effective_save_defect_images and defect_img_dir and image_zf is not None:
                    img_node = defect.find("image")
                    if img_node is not None:
                        member = find_image_member(image_members, img_node.attrib.get("src"))
                        if member:
                            target_path = copy_zip_image(image_zf, member, defect_img_dir)
                            if target_path:
                                image_src_rel = safe_join_relpath(target_path)

                coords_payload: List[Dict[str, Optional[List[float]]]] = []
                for pd_node in defect.findall(".//pds/pd"):
                    x_vals = parse_float_list(pd_node.findtext("x"))
                    y_vals = parse_float_list(pd_node.findtext("y"))
                    if not x_vals and not y_vals:
                        continue
                    coords_payload.append({"x": x_vals, "y": y_vals})
                if not coords_payload:
                    bounds = parse_float_list(defect.attrib.get("coords"))
                    if bounds and len(bounds) == 4:
                        x1, y1, x2, y2 = bounds
                        coords_payload.append(
                            {
                                "x": [x1, x2, x2, x1],
                                "y": [y1, y1, y2, y2],
                            }
                        )
                coords_value = coords_payload or None

                defect_rows.append(
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
            if defect_rows:
                session.bulk_save_objects(defect_rows)

            if effective_save_reference_images and reference_img_dir and image_zf is not None:
                ref_entries: List[Dict[str, Optional[str]]] = []

                for ref_node in root.findall(".//reference_images/*"):
                    attrs = dict(ref_node.attrib)
                    path = (
                        attrs.get("src")
                        or attrs.get("href")
                        or attrs.get("file")
                        or attrs.get("name")
                        or ((ref_node.text or "").strip() if ref_node.text else None)
                    )
                    ref_id = attrs.get("id")
                    format_val = (
                        attrs.get("format")
                        or attrs.get("formatposition")
                        or attrs.get("position")
                        or (ref_id.split("_")[-1] if ref_id and "_" in ref_id else None)
                    )

                    if path:
                        ref_entries.append(
                            {
                                "path": normalize_zip_image_path(path),
                                "format": format_val,
                            }
                        )

                if not ref_entries:
                    for member_path in sorted(image_members):
                        if "reference" in member_path.lower():
                            ref_entries.append({"path": member_path, "format": None})

                seen_ref_members = set()
                used_ref_filenames = set()
                reference_rows = []
                for ref in ref_entries:
                    member = find_image_member(image_members, ref.get("path"))
                    if not member:
                        continue

                    if member in seen_ref_members:
                        continue
                    seen_ref_members.add(member)

                    basename = unique_filename(
                        os.path.basename(normalize_zip_image_path(member)),
                        used_ref_filenames,
                    )
                    target_path = copy_zip_image(
                        image_zf,
                        member,
                        reference_img_dir,
                        target_basename=basename,
                    )
                    if not target_path:
                        continue
                    image_src_rel = safe_join_relpath(target_path)

                    reference_rows.append(
                        ReferenceImage(
                            reel_id=reel.reel_id,
                            filename=basename,
                            image_src=image_src_rel,
                            format=ref.get("format"),
                        )
                    )
                if reference_rows:
                    session.bulk_save_objects(reference_rows)

            mask_rows = []
            for m in root.findall(".//masks//mask"):
                props = dict(m.attrib)
                prop_node = m.find(".//properties")
                if prop_node is not None:
                    props.update(prop_node.attrib)

                sensitivitysetid = props.get("sensitivitysetid")
                noinspection_str = props.get("noinspection", "false").lower()
                if not (sensitivitysetid == "sId_mmx_noinsp" and noinspection_str == "true"):
                    continue

                mask_date_str = props.get("date") or m.attrib.get("date")
                mask_time_str = props.get("time") or m.attrib.get("time")
                ts = None
                if mask_date_str and mask_time_str:
                    try:
                        ts = parse_datetime(mask_date_str, mask_time_str)
                    except Exception:
                        pass

                coords = props.get("coords") or ""
                fmt_val = None
                try:
                    raw_format = props.get("format")
                    fmt_val = float(raw_format) if raw_format not in (None, "") else None
                except Exception:
                    fmt_val = None

                mask_rows.append(
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

                removal = mask_removal_event(m, reel.reel_id)
                if removal is not None:
                    mask_rows.append(removal)
            if mask_rows:
                session.bulk_save_objects(mask_rows)

            session.commit()
            image_bits = []
            if effective_save_reference_images:
                image_bits.append("reference images")
            if effective_save_defect_images:
                image_bits.append("defect images")
            image_label = f" with {', '.join(image_bits)}" if image_bits else ""
            print(
                f"✅ Inserted Reel {reel.reel_id} ({machine_name}: {order_number}/{job_name}) "
                f"and BST data{image_label}. "
                f"save_reference_images={effective_save_reference_images}, "
                f"save_defect_images={effective_save_defect_images}, import_mode={import_mode}"
            )

    except Exception as e:
        print(f"❌ Failed on {zip_path} for {machine_name}: {e}")
        raise
    finally:
        if image_zf is not None:
            image_zf.close()


if __name__ == "__main__":
    test_file = "data/Press 5/2025-09-16_23-32_903286_11.zip"
    extract_one(
        test_file,
        "Press 5",
        import_mode="full",
        save_reference_images=True,
        save_defect_images=False,
    )

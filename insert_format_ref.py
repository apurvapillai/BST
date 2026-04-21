from __future__ import annotations

import io
import os
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import requests
from bs4 import BeautifulSoup
from sqlalchemy.orm import Session

from db.connection import engine
from db.models import Machine, Reel, ReferenceImage


MACHINES = [
    {"name": "Press 5", "host": "192.168.20.61", "base_path": "protocol"},
    {"name": "Press 14", "host": "192.168.20.147", "base_path": "protocol"},
]

DEFAULT_COOKIE = "JSESSIONID=abc123xyz; othercookie=value"
COOKIE_FROM_ENV = os.environ.get("PROTOCOL_COOKIE")
CUTOFF_DATE = datetime(2026, 4, 6)

DRY_RUN = False
ONLY_UPDATE_NULL_FORMAT = True


def parse_datetime(date_str: str, time_str: str) -> datetime:
    return datetime.strptime(f"{date_str} {time_str}", "%Y-%m-%d %H:%M:%S")


def attr_as_float(node: Optional[ET.Element], attr: str) -> Optional[float]:
    if node is None:
        return None
    try:
        val = node.attrib.get(attr)
        return float(val) if val is not None and val != "" else None
    except Exception:
        return None


def base_page(host: str, base_path: str = "protocol") -> str:
    return f"http://{host}/user/remote/{base_path}/download/"


def build_headers(host: str, base_path: str = "protocol") -> dict:
    return {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/109.0.0.0 Safari/537.36"
        ),
        "Referer": base_page(host, base_path),
        "Cookie": COOKIE_FROM_ENV or DEFAULT_COOKIE,
    }


def parse_zip_timestamp(filename: str) -> Optional[datetime]:
    stem = Path(filename).stem
    parts = stem.split("_")
    candidates: List[str] = []

    if len(parts) >= 2:
        candidates.append("_".join(parts[:2]))
    if parts:
        candidates.append(parts[0])

    for candidate in candidates:
        for fmt in ("%Y-%m-%d_%H-%M", "%Y-%m-%d"):
            try:
                return datetime.strptime(candidate, fmt)
            except ValueError:
                continue
    return None


def resolve_zip_url(host: str, href: str, base_path: str = "protocol") -> str:
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if href.startswith("data/"):
        return f"http://{host}/user/remote/{base_path}/" + href
    return base_page(host, base_path) + href


def fetch_zip_catalog(
    session: requests.Session,
    host: str,
    base_path: str = "protocol",
) -> Iterable[Tuple[str, str, Optional[datetime]]]:
    response = session.get(base_page(host, base_path), timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if not href.lower().endswith(".zip"):
            continue
        filename = os.path.basename(href)
        yield (
            filename,
            resolve_zip_url(host, href, base_path),
            parse_zip_timestamp(filename),
        )


def read_report_xml_from_zip_url(session: requests.Session, url: str) -> ET.Element:
    response = session.get(url, timeout=60)
    response.raise_for_status()

    data = response.content
    if not data[:4].startswith(b"PK"):
        raise ValueError("Downloaded content is not a ZIP")

    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        xml_name_candidates = [n for n in zf.namelist() if n.lower().endswith("report.xml")]
        if not xml_name_candidates:
            raise ValueError("No report.xml found in ZIP")

        with zf.open(xml_name_candidates[0]) as f:
            tree = ET.parse(f)
            return tree.getroot()


def find_matching_reel(session: Session, machine_name: str, root: ET.Element) -> Optional[Reel]:
    order_node = root.find("order")
    job_node = root.find("order/job")
    order_number = order_node.attrib.get("number") if order_node is not None else None
    job_name = job_node.attrib.get("name") if job_node is not None else None

    reelstart_node = root.find("production/reelstart")
    reelend_node = root.find("production/reelend")
    reel_start = attr_as_float(reelstart_node, "format")
    reel_end = attr_as_float(reelend_node, "format")

    start_node = root.find("production/productiontime/start")
    end_node = root.find("production/productiontime/end")
    if start_node is None or end_node is None:
        return None

    time_start = parse_datetime(start_node.attrib["date"], start_node.attrib["time"])
    time_end = parse_datetime(end_node.attrib["date"], end_node.attrib["time"])

    machine = session.query(Machine).filter_by(name=machine_name).first()
    if not machine:
        raise ValueError(f"Machine {machine_name} not found")

    return session.query(Reel).filter_by(
        machine_id=machine.machine_id,
        order_number=order_number,
        job_name=job_name,
        reel_start=reel_start,
        reel_end=reel_end,
        time_start=time_start,
        time_end=time_end,
    ).first()


def extract_reference_entries(root: ET.Element) -> List[Dict[str, Optional[str]]]:
    entries: List[Dict[str, Optional[str]]] = []

    for ref_node in root.findall(".//reference_images/*"):
        attrs = dict(ref_node.attrib)

        raw_path = (
            attrs.get("src")
            or attrs.get("href")
            or attrs.get("file")
            or attrs.get("name")
            or ((ref_node.text or "").strip() if ref_node.text else None)
        )

        ref_id = attrs.get("id")
        format_val = ref_id.split("_")[-1] if ref_id and "_" in ref_id else None

        if not raw_path or not format_val:
            continue

        basename = os.path.basename(raw_path.replace("\\", "/"))
        if not basename:
            continue

        entries.append(
            {
                "filename": basename,
                "format": format_val,
                "xml_id": ref_id,
            }
        )

    return entries


def update_reference_formats_for_reel(
    session: Session,
    reel: Reel,
    entries: List[Dict[str, Optional[str]]],
    machine_name: str,
) -> Tuple[int, int, int]:
    updated = 0
    skipped = 0
    missing = 0

    db_refs = session.query(ReferenceImage).filter_by(reel_id=reel.reel_id).all()
    by_filename = {r.filename: r for r in db_refs}

    print(f"   reel_id={reel.reel_id}, DB reference rows={len(db_refs)}, XML reference rows={len(entries)}")

    for entry in entries:
        filename = entry["filename"]
        format_val = entry["format"]
        xml_id = entry["xml_id"]

        if not filename or not format_val:
            skipped += 1
            continue

        ref_row = by_filename.get(filename)
        if not ref_row:
            print(
                f"   ⚠️ No matching reference_images row for reel_id={reel.reel_id}, "
                f"filename={filename}, xml_id={xml_id}"
            )
            missing += 1
            continue

        old_val = ref_row.format

        if ONLY_UPDATE_NULL_FORMAT and old_val not in (None, ""):
            print(
                f"   ⏭️ Skipping filename={filename} because format already has value {old_val!r}"
            )
            skipped += 1
            continue

        if old_val == format_val:
            print(
                f"   ⏭️ Skipping filename={filename} because format already equals {format_val!r}"
            )
            skipped += 1
            continue

        print(
            f"   ✏️ Updating reel_id={reel.reel_id}, filename={filename}, xml_id={xml_id}: "
            f"format {old_val!r} -> {format_val!r}"
        )

        if not DRY_RUN:
            ref_row.format = format_val

        updated += 1

    return updated, skipped, missing


def backfill_machine(machine_name: str, host: str, base_path: str = "protocol") -> None:
    print(f"\n{'=' * 80}")
    print(f"Backfilling reference_images.format for {machine_name} ({host})")
    print(f"{'=' * 80}")

    http = requests.Session()
    http.headers.update(build_headers(host, base_path))

    catalog = list(fetch_zip_catalog(http, host, base_path))
    catalog.sort(key=lambda x: (x[2] or datetime.min, x[0]))

    scanned = 0
    matched_reels = 0
    total_updated = 0
    total_skipped = 0
    total_missing = 0

    with Session(engine) as session:
        for filename, url, ts in catalog:
            if ts and ts <= CUTOFF_DATE:
                continue

            scanned += 1
            print(f"\n📦 {filename}")

            try:
                root = read_report_xml_from_zip_url(http, url)
            except Exception as exc:
                print(f"   ❌ Failed to read report.xml: {exc}")
                continue

            try:
                reel = find_matching_reel(session, machine_name, root)
            except Exception as exc:
                print(f"   ❌ Failed during reel lookup: {exc}")
                continue

            if not reel:
                print("   ⏭️ No matching reel found in reels table")
                continue

            matched_reels += 1

            entries = extract_reference_entries(root)
            if not entries:
                print("   ⏭️ No usable reference image entries found in XML")
                continue

            updated, skipped, missing = update_reference_formats_for_reel(
                session=session,
                reel=reel,
                entries=entries,
                machine_name=machine_name,
            )

            total_updated += updated
            total_skipped += skipped
            total_missing += missing

        if DRY_RUN:
            session.rollback()
            print("\nDRY_RUN=True, rollback complete. No DB rows changed.")
        else:
            session.commit()
            print("\n✅ Commit complete.")

    print(f"\nSummary for {machine_name}:")
    print(f"  ZIPs scanned: {scanned}")
    print(f"  Reels matched: {matched_reels}")
    print(f"  Rows updated: {total_updated}")
    print(f"  Rows skipped: {total_skipped}")
    print(f"  Rows missing filename match: {total_missing}")


def main() -> None:
    for machine in MACHINES:
        backfill_machine(
            machine_name=machine["name"],
            host=machine["host"],
            base_path=machine.get("base_path", "protocol"),
        )


if __name__ == "__main__":
    main()
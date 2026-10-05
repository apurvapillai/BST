import csv
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from pathlib import Path

from sqlalchemy.orm import Session, joinedload

from db.connection import engine
from db.models import Reel


START_DATE = date(2026, 9, 13)
END_DATE = date(2026, 9, 23)
OUTPUT_PATH = Path("exports") / "reference_overview_all_machines_2026-09-13_to_2026-09-23.csv"


def ordered_reference_images(reel: Reel):
    images = [
        image
        for image in (reel.reference_images or [])
        if (image.filename and image.filename.strip())
        or (image.image_src and image.image_src.strip())
    ]
    return sorted(
        images,
        key=lambda image: (
            image.ref_image_id or 0,
            (image.filename or "").strip().lower(),
            (image.image_src or "").strip().lower(),
        ),
    )


def export_csv() -> Path:
    start_datetime = datetime.combine(START_DATE, time.min)
    end_datetime_exclusive = datetime.combine(END_DATE + timedelta(days=1), time.min)
    grouped = defaultdict(
        lambda: {
            "total_reels": 0,
            "total_reference_image_changes": 0,
            "reels_with_1_reference_image_change": 0,
            "reels_with_multiple_reference_images": 0,
        }
    )

    with Session(engine) as session:
        reels = (
            session.query(Reel)
            .options(joinedload(Reel.machine), joinedload(Reel.reference_images))
            .filter(Reel.time_start >= start_datetime)
            .filter(Reel.time_start < end_datetime_exclusive)
            .order_by(Reel.time_start, Reel.reel_id)
            .all()
        )

        for reel in reels:
            if reel.time_start is None:
                continue

            reference_count = len(ordered_reference_images(reel))
            change_count = max(reference_count - 1, 0)
            key = (
                reel.time_start.date().isoformat(),
                reel.machine.name if reel.machine else "Unassigned",
                reel.job_name or "Unassigned",
                reel.order_number or "",
            )
            summary = grouped[key]
            summary["total_reels"] += 1
            summary["total_reference_image_changes"] += change_count
            if change_count == 1:
                summary["reels_with_1_reference_image_change"] += 1
            if reference_count > 1:
                summary["reels_with_multiple_reference_images"] += 1

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "machine",
        "date",
        "job_number",
        "order_number",
        "total_reels",
        "total_reference_image_changes",
        "reels_with_1_reference_image_change",
        "reels_with_multiple_reference_images",
    ]

    with OUTPUT_PATH.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for (reel_date, machine, job_number, order_number), summary in sorted(grouped.items()):
            writer.writerow(
                {
                    "machine": machine,
                    "date": reel_date,
                    "job_number": job_number,
                    "order_number": order_number,
                    **summary,
                }
            )

    return OUTPUT_PATH


if __name__ == "__main__":
    print(f"Wrote {export_csv()}")
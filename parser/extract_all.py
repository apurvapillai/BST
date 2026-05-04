import os
from datetime import datetime
from pathlib import Path

from parser.extract_one import extract_one

DATA_DIR = Path("data")

MACHINES = [
    "Press 5",
    "Press 6",
    "Press 7",
    "Press 8",
    "Press 9",
    "Press 11",
    "Press 12",
    "Press 13",
    "Press 14",
    "Press 15",
]

CUTOFF_DATE = datetime(2025, 10, 30)


def extract_all():
    for machine_name in MACHINES:
        machine_dir = DATA_DIR / machine_name

        if not machine_dir.exists():
            print(f"⚠️ Skipping {machine_name}: folder not found -> {machine_dir}")
            continue

        for fname in os.listdir(machine_dir):
            if not fname.lower().endswith(".zip"):
                continue

            try:
                date_part = fname.split("_")[0]
                file_date = datetime.strptime(date_part, "%Y-%m-%d")
            except Exception:
                print(f"⚠️ Skipping {fname}: could not parse date from filename.")
                continue

            if file_date < CUTOFF_DATE:
                print(f"⏩ Skipping {fname}: {file_date.date()} < cutoff {CUTOFF_DATE.date()}")
                continue

            zip_path = machine_dir / fname
            print(f"📦 Processing {zip_path} for {machine_name} ...")

            try:
                extract_one(
                    str(zip_path),
                    machine_name,
                    import_mode="full",
                    save_reference_images=True,
                    save_defect_images=False,
                )
            except Exception as e:
                print(f"❌ Failed on {zip_path}: {e}")


if __name__ == "__main__":
    extract_all()

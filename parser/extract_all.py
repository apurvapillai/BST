import os
from datetime import datetime
from parser.extract_one import extract_one

DATA_DIR = "data"

# --- 👇 Adjustable cutoff date (edit anytime) ---
CUTOFF_DATE = datetime(2025, 10, 21)  # only process ZIPs newer than this


def extract_all():
    """Loop through all zip files in DATA_DIR and insert into DB."""
    for root, _, files in os.walk(DATA_DIR):
        for fname in files:
            if not fname.lower().endswith(".zip"):
                continue

            # --- Extract date from filename (format: YYYY-MM-DD_...) ---
            try:
                date_part = fname.split("_")[0]
                file_date = datetime.strptime(date_part, "%Y-%m-%d")
            except Exception:
                print(f"⚠️ Skipping {fname}: could not parse date from filename.")
                continue

            # --- Skip if before cutoff ---
            if file_date < CUTOFF_DATE:
                print(f"⏩ Skipping {fname}: {file_date.date()} < cutoff {CUTOFF_DATE.date()}")
                continue

            zip_path = os.path.join(root, fname)
            print(f"📦 Processing {zip_path} ...")
            try:
                extract_one(zip_path)

                # Uncomment if you want to delete files after processing
                # os.remove(zip_path)
                # print(f"🗑️ Deleted {zip_path} after successful import")

            except Exception as e:
                print(f"❌ Failed on {zip_path}: {e}")


if __name__ == "__main__":
    extract_all()

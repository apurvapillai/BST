import os
import requests
from bs4 import BeautifulSoup
from datetime import datetime

BASE_PAGE = "http://192.168.20.61/user/remote/protocol/download/"
OUTPUT_DIR = "data"
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ⚠️ Replace with your real cookie string from Chrome
headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Safari/537.36",
    "Referer": BASE_PAGE,
    "Cookie": "JSESSIONID=abc123xyz; othercookie=value",
}

session = requests.Session()
session.headers.update(headers)

# Define cutoff date (only download zips newer than this)
CUTOFF_DATE = datetime(2025, 10, 30)  # adjust as needed

# Fetch the main page
resp = session.get(BASE_PAGE)
resp.raise_for_status()
soup = BeautifulSoup(resp.text, "html.parser")

for link in soup.find_all("a", href=True):
    href = link["href"]
    if href.endswith(".zip"):
        filename = os.path.basename(href)

        # Parse date prefix (first 10 chars = YYYY-MM-DD)
        try:
            file_date = datetime.strptime(filename[:10], "%Y-%m-%d")
        except ValueError:
            print(f"⚠️ Skipping {filename}, could not parse date")
            continue

        # Skip if file date is older than cutoff
        if file_date <= CUTOFF_DATE:
            print(f"⏩ Skipping {filename}, date {file_date.date()} <= cutoff {CUTOFF_DATE.date()}")
            continue

        # 🔑 Build correct URL
        if href.startswith("data/"):
            url = "http://192.168.20.61/user/remote/protocol/" + href
        else:
            url = BASE_PAGE + href

        out_path = os.path.join(OUTPUT_DIR, filename)
        if os.path.exists(out_path):
            print(f"⚠️ Skipping {filename}, already exists")
            continue

        print(f"Trying {filename}")
        print("Resolved URL:", url)

        r = session.get(url, stream=True)
        r.raise_for_status()

        # Peek first 4 bytes to check if it's a ZIP
        first_chunk = r.raw.read(4)
        if not first_chunk.startswith(b"PK"):
            print(f"❌ {filename} is not a valid ZIP (got HTML instead)")
        else:
            with open(out_path, "wb") as f:
                f.write(first_chunk)
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            print(f"✅ Saved {filename}")

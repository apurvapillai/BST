"""
Automated pipeline that:
  1. Fetches ZIP reports from the remote press protocol page.
  2. Downloads only reports newer than the last successful import.
  3. Imports each ZIP via parser.extract_one.extract_one.
  4. Removes processed ZIPs only after a successful import.
  5. Persists the latest processed ZIP metadata to resume on next run.

Configuration notes:
  - Update BASE_PAGE / headers as needed (especially the Cookie value).
  - Optionally set PROTOCOL_COOKIE env var to override the Cookie header.
  - Adjust CUTOFF_DATE if you need a hard lower bound on historical imports.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable, List, Optional

import requests
from bs4 import BeautifulSoup

from parser.extract_one import extract_one

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

BASE_PAGE = "http://192.168.20.61/user/remote/protocol/download/"
DATA_DIR = Path("data")
STATE_PATH = DATA_DIR / ".sync_state.json"
DATA_DIR.mkdir(parents=True, exist_ok=True)

CUTOFF_DATE = datetime(2025, 10, 30)  # ignore ZIPs on/before this date

DEFAULT_COOKIE = "JSESSIONID=abc123xyz; othercookie=value"
COOKIE_FROM_ENV = os.environ.get("PROTOCOL_COOKIE")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/109.0.0.0 Safari/537.36"
    ),
    "Referer": BASE_PAGE,
    "Cookie": COOKIE_FROM_ENV or DEFAULT_COOKIE,
}


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

@dataclass
class State:
    last_processed_zip: Optional[str] = None
    last_processed_ts: Optional[str] = None  # ISO string

    @property
    def last_timestamp(self) -> Optional[datetime]:
        if not self.last_processed_ts:
            return None
        try:
            return datetime.fromisoformat(self.last_processed_ts)
        except ValueError:
            return None


@dataclass
class ZipEntry:
    filename: str
    url: str
    timestamp: Optional[datetime]

    @property
    def display_timestamp(self) -> str:
        return self.timestamp.isoformat() if self.timestamp else "unknown"


def load_state() -> State:
    if not STATE_PATH.exists():
        return State()
    try:
        with STATE_PATH.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return State()
    return State(
        last_processed_zip=payload.get("last_processed_zip"),
        last_processed_ts=payload.get("last_processed_ts"),
    )


def save_state(state: State) -> None:
    try:
        with STATE_PATH.open("w", encoding="utf-8") as handle:
            json.dump(
                {
                    "last_processed_zip": state.last_processed_zip,
                    "last_processed_ts": state.last_processed_ts,
                },
                handle,
                indent=2,
            )
    except OSError as exc:
        print(f"⚠️  Failed to persist state: {exc}", file=sys.stderr)


def parse_zip_timestamp(filename: str) -> Optional[datetime]:
    """
    Try to derive a datetime from filenames like 'YYYY-MM-DD_HH-MM_foo.zip'.
    Returns None if parsing fails.
    """
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


def resolve_zip_url(href: str) -> str:
    if href.startswith("http://") or href.startswith("https://"):
        return href
    if href.startswith("data/"):
        return "http://192.168.20.61/user/remote/protocol/" + href
    return BASE_PAGE + href


def fetch_zip_catalog(session: requests.Session) -> Iterable[ZipEntry]:
    response = session.get(BASE_PAGE, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if not href.lower().endswith(".zip"):
            continue
        filename = os.path.basename(href)
        yield ZipEntry(
            filename=filename,
            url=resolve_zip_url(href),
            timestamp=parse_zip_timestamp(filename),
        )


def download_zip(session: requests.Session, entry: ZipEntry, target: Path) -> None:
    response = session.get(entry.url, stream=True, timeout=60)
    response.raise_for_status()

    target.parent.mkdir(parents=True, exist_ok=True)

    # Inspect first bytes to verify ZIP signature.
    first_chunk = response.raw.read(4)
    if not first_chunk.startswith(b"PK"):
        raise ValueError(f"{entry.filename} does not look like a ZIP (missing PK header)")

    with target.open("wb") as handle:
        handle.write(first_chunk)
        for chunk in response.iter_content(chunk_size=8192):
            handle.write(chunk)


def should_process(entry: ZipEntry, state: State) -> bool:
    if entry.timestamp and entry.timestamp <= CUTOFF_DATE:
        print(
            f"⏩ Skipping {entry.filename}: {entry.display_timestamp} <= cutoff {CUTOFF_DATE.isoformat()}"
        )
        return False
    last_ts = state.last_timestamp
    if last_ts and entry.timestamp:
        if entry.timestamp <= last_ts:
            print(
                f"⏩ Skipping {entry.filename}: {entry.display_timestamp} <= last processed {last_ts.isoformat()}"
            )
            return False
    return True


# --------------------------------------------------------------------------- #
# Core workflow
# --------------------------------------------------------------------------- #

def sync_reports() -> None:
    session = requests.Session()
    session.headers.update(HEADERS)

    state = load_state()
    print(
        f"🔄 Starting sync; last processed zip: {state.last_processed_zip or 'none'}, "
        f"timestamp: {state.last_processed_ts or 'unknown'}"
    )

    entries = [
        entry
        for entry in fetch_zip_catalog(session)
        if should_process(entry, state)
    ]

    if not entries:
        print("✅ Nothing new to import.")
        return

    entries.sort(key=lambda e: (e.timestamp or datetime.min, e.filename))

    for entry in entries:
        target_path = DATA_DIR / entry.filename
        try:
            if target_path.exists():
                print(f"♻️  Using existing file {entry.filename}")
            else:
                print(f"⬇️  Downloading {entry.filename} ({entry.url}) ...")
                download_zip(session, entry, target_path)

            print(f"📦 Importing {entry.filename} ...")
            extract_one(str(target_path))

        except Exception as exc:
            print(f"❌ Failed to process {entry.filename}: {exc}")
            print("   File retained for inspection.")
            continue

        # Success: update state and remove file.
        state.last_processed_zip = Path(entry.filename).stem
        state.last_processed_ts = (
            entry.timestamp.isoformat() if entry.timestamp else datetime.utcnow().isoformat()
        )
        save_state(state)

        try:
            target_path.unlink()
            print(f"🗑️  Removed {entry.filename} after successful import.")
        except OSError as exc:
            print(f"⚠️  Failed to delete {entry.filename}: {exc}")

    print("✅ Sync complete.")


if __name__ == "__main__":
    try:
        sync_reports()
    except Exception as error:
        print(f"❌ Sync run failed: {error}")
        sys.exit(1)

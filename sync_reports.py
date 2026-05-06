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
# Machine registry
# --------------------------------------------------------------------------- #

DEFAULT_MACHINE_CAPTURE = {
    "import_mode": "full",
    "save_reference_images": True,
    "save_defect_images": False,
}

MACHINES = [
    {"name": "Press 5", "host": "192.168.20.61", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 6", "host": "192.168.20.64", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 7", "host": "192.168.20.62", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 8", "host": "192.168.20.63", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 9", "host": "192.168.20.78", **DEFAULT_MACHINE_CAPTURE},
    {
        "name": "Press 11",
        "host": "192.168.20.82",
        **DEFAULT_MACHINE_CAPTURE,
        "base_path": "protocols",
    },
    {"name": "Press 12", "host": "192.168.20.83", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 13", "host": "192.168.20.170", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 14", "host": "192.168.20.147", **DEFAULT_MACHINE_CAPTURE},
    {"name": "Press 15", "host": "192.168.20.126", **DEFAULT_MACHINE_CAPTURE},
]

DATA_ROOT = Path("data")
DATA_ROOT.mkdir(parents=True, exist_ok=True)

CUTOFF_DATE = datetime(2025, 10, 30)

DEFAULT_COOKIE = "JSESSIONID=abc123xyz; othercookie=value"
COOKIE_FROM_ENV = os.environ.get("PROTOCOL_COOKIE")
DOWNLOAD_CHUNK_SIZE = 1024 * 1024


# --------------------------------------------------------------------------- #
# Models
# --------------------------------------------------------------------------- #

@dataclass
class State:
    last_processed_zip: Optional[str] = None
    last_processed_ts: Optional[str] = None

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


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #

def machine_dir(machine_name: str) -> Path:
    path = DATA_ROOT / machine_name
    path.mkdir(parents=True, exist_ok=True)
    return path


def state_path(machine_name: str) -> Path:
    return machine_dir(machine_name) / ".sync_state.json"


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


def load_state(machine_name: str) -> State:
    spath = state_path(machine_name)
    if not spath.exists():
        return State()
    try:
        with spath.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (json.JSONDecodeError, OSError):
        return State()
    return State(
        last_processed_zip=payload.get("last_processed_zip"),
        last_processed_ts=payload.get("last_processed_ts"),
    )


def save_state(machine_name: str, state: State) -> None:
    spath = state_path(machine_name)
    try:
        with spath.open("w", encoding="utf-8") as handle:
            json.dump(
                {
                    "last_processed_zip": state.last_processed_zip,
                    "last_processed_ts": state.last_processed_ts,
                },
                handle,
                indent=2,
            )
    except OSError as exc:
        print(f"⚠️ Failed to persist state for {machine_name}: {exc}", file=sys.stderr)


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
) -> Iterable[ZipEntry]:
    response = session.get(base_page(host, base_path), timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    for link in soup.find_all("a", href=True):
        href = link["href"]
        if not href.lower().endswith(".zip"):
            continue
        filename = os.path.basename(href)
        yield ZipEntry(
            filename=filename,
            url=resolve_zip_url(host, href, base_path),
            timestamp=parse_zip_timestamp(filename),
        )


def download_zip(session: requests.Session, entry: ZipEntry, target: Path) -> None:
    response = session.get(entry.url, stream=True, timeout=60)
    response.raise_for_status()

    target.parent.mkdir(parents=True, exist_ok=True)
    temp_target = target.with_name(f"{target.name}.part")

    saw_content = False
    try:
        with temp_target.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=DOWNLOAD_CHUNK_SIZE):
                if not chunk:
                    continue
                if not saw_content:
                    if not chunk.startswith(b"PK"):
                        raise ValueError(f"{entry.filename} does not look like a ZIP (missing PK header)")
                    saw_content = True
                handle.write(chunk)
        if not saw_content:
            raise ValueError(f"{entry.filename} downloaded as an empty response")
        temp_target.replace(target)
    except Exception:
        try:
            temp_target.unlink()
        except OSError:
            pass
        raise


def should_process(entry: ZipEntry, state: State) -> bool:
    if entry.timestamp and entry.timestamp <= CUTOFF_DATE:
        return False

    last_ts = state.last_timestamp
    if last_ts and entry.timestamp and entry.timestamp <= last_ts:
        return False

    return True


# --------------------------------------------------------------------------- #
# Core workflow
# --------------------------------------------------------------------------- #

def sync_machine(
    machine_name: str,
    host: str,
    save_images: Optional[bool] = None,
    import_mode: str = "full",
    base_path: str = "protocol",
    save_reference_images: Optional[bool] = None,
    save_defect_images: Optional[bool] = None,
) -> None:
    legacy_save_images = True if save_images is None else save_images
    reference_images_enabled = (
        legacy_save_images if save_reference_images is None else save_reference_images
    )
    defect_images_enabled = legacy_save_images if save_defect_images is None else save_defect_images

    print(f"\n{'=' * 80}")
    print(f"🔄 Syncing {machine_name} ({host})")
    print(
        f"   mode={import_mode}, reference_images={reference_images_enabled}, "
        f"defect_images={defect_images_enabled}, base_path={base_path}"
    )
    print(f"{'=' * 80}")

    session = requests.Session()
    session.headers.update(build_headers(host, base_path))

    state = load_state(machine_name)
    print(
        f"Last processed zip: {state.last_processed_zip or 'none'}, "
        f"timestamp: {state.last_processed_ts or 'unknown'}"
    )

    entries = [
        entry
        for entry in fetch_zip_catalog(session, host, base_path)
        if should_process(entry, state)
    ]

    if not entries:
        print(f"✅ Nothing new to import for {machine_name}.")
        return

    entries.sort(key=lambda e: (e.timestamp or datetime.min, e.filename))

    for entry in entries:
        target_path = machine_dir(machine_name) / entry.filename

        try:
            if target_path.exists():
                print(f"♻️ Using existing file {target_path}")
            else:
                print(f"⬇️ Downloading {entry.filename} from {machine_name} ...")
                download_zip(session, entry, target_path)

            print(f"📦 Importing {target_path} ...")
            extract_one(
                str(target_path),
                machine_name,
                save_images=legacy_save_images,
                import_mode=import_mode,
                save_reference_images=save_reference_images,
                save_defect_images=save_defect_images,
            )

            # only mark success after extract_one finishes
            state.last_processed_zip = Path(entry.filename).stem
            state.last_processed_ts = (
                entry.timestamp.isoformat() if entry.timestamp else datetime.utcnow().isoformat()
            )
            save_state(machine_name, state)

            # delete only after successful DB import + image copy
            try:
                target_path.unlink()
                print(f"🗑️ Removed {target_path} after successful import.")
            except OSError as exc:
                print(f"⚠️ Failed to delete {target_path}: {exc}")

        except Exception as exc:
            print(f"❌ Failed to process {entry.filename} for {machine_name}: {exc}")
            print("   File retained for inspection.")
            continue

    print(f"✅ Sync complete for {machine_name}.")


def sync_reports() -> None:
    for machine in MACHINES:
        sync_machine(
            machine_name=machine["name"],
            host=machine["host"],
            save_images=machine.get("save_images"),
            import_mode=machine.get("import_mode", "full"),
            base_path=machine.get("base_path", "protocol"),
            save_reference_images=machine.get("save_reference_images"),
            save_defect_images=machine.get("save_defect_images"),
        )


if __name__ == "__main__":
    try:
        sync_reports()
    except Exception as error:
        print(f"❌ Sync run failed: {error}")
        sys.exit(1)

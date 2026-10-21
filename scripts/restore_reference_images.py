"""Restore reference images for already-imported reels from retained report ZIPs."""

from pathlib import Path

from parser.extract_one import extract_one


ARCHIVE_ROOT = Path("data") / "review_archive"


def main() -> None:
    archives = sorted(ARCHIVE_ROOT.glob("*/*.zip"))
    if not archives:
        print(f"No report ZIPs found under {ARCHIVE_ROOT}")
        return

    restored = 0
    failed = 0
    for archive in archives:
        machine_name = archive.parent.name
        print(f"Restoring reference images from {archive} for {machine_name} ...")
        try:
            extract_one(
                str(archive),
                machine_name,
                import_mode="full",
                save_reference_images=True,
                save_defect_images=False,
            )
            restored += 1
        except Exception as exc:
            failed += 1
            print(f"Failed to restore {archive}: {exc}")

    print(f"Reference-image restore complete: {restored} archive(s), {failed} failure(s).")


if __name__ == "__main__":
    main()

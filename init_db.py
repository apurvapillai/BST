from sqlalchemy import text
from db.connection import engine, Base
from db import models  # noqa: F401 (import models so Base knows them)


def init_db(drop_existing: bool = False):
    """Initialize the database schema from models.py"""
    with engine.connect() as conn:
        if drop_existing:
            print("⚠️ Dropping existing tables (force)...")
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 0;"))
            # brute-force drop known tables
            conn.execute(text("DROP TABLE IF EXISTS sensitivity_sets;"))
            conn.execute(text("DROP TABLE IF EXISTS defects;"))
            conn.execute(text("DROP TABLE IF EXISTS reels;"))
            conn.execute(text("DROP TABLE IF EXISTS machines;"))
            conn.execute(text("SET FOREIGN_KEY_CHECKS = 1;"))

        print("📦 Creating tables...")
        Base.metadata.create_all(bind=engine)
        print("✅ Done.")


if __name__ == "__main__":
    # Change to False if you just want to ensure tables exist
    init_db(drop_existing=True)

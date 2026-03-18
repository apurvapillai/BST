from __future__ import annotations

import os
from typing import Generator, Optional

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

# Ensure env vars are available (mirrors db/connection.py behaviour)
load_dotenv()


def _build_db_url() -> str:
    """
    Construct the RLM DB URL from either RLM_DB_URL or discrete env vars.
    Falls back to the default DB_* vars if no RLM-specific values are provided.
    """
    url = os.environ.get("RLM_DB_URL") or os.environ.get("DB_URL")
    if url:
        return url

    def _get(name: str, fallback: Optional[str] = None) -> Optional[str]:
        return os.environ.get(name) or os.environ.get(fallback) if fallback else os.environ.get(name)

    host = _get("RLM_DB_HOST", "DB_HOST")
    user = _get("RLM_DB_USER", "DB_USER")
    password = _get("RLM_DB_PASSWORD", "DB_PASSWORD")
    name = _get("RLM_DB_NAME", "DB_NAME")

    missing = [key for key, value in [("RLM_DB_HOST/DB_HOST", host), ("RLM_DB_USER/DB_USER", user), ("RLM_DB_PASSWORD/DB_PASSWORD", password), ("RLM_DB_NAME/DB_NAME", name)] if not value]
    if missing:
        raise RuntimeError(f"Missing RLM DB env vars: {', '.join(missing)}")

    return f"mysql+mysqlconnector://{user}:{password}@{host}/{name}?charset=utf8mb4"


RLM_DB_URL = _build_db_url()
RLM_DB_SSL_CA: Optional[str] = os.environ.get("RLM_DB_SSL_CA") or os.environ.get("DB_SSL_CA")

connect_args = {"connection_timeout": 5}
if RLM_DB_SSL_CA:
    connect_args["ssl_ca"] = RLM_DB_SSL_CA

rlm_engine = create_engine(
    RLM_DB_URL,
    echo=False,
    future=True,
    connect_args=connect_args,
    pool_pre_ping=True,
)

RLMBase = declarative_base()
RLMSessionLocal = sessionmaker(bind=rlm_engine, autoflush=False, autocommit=False, future=True)


def get_rlm_db() -> Generator:
    """Yield a dedicated session for the pressbstrlm database."""
    session = RLMSessionLocal()
    try:
        yield session
    finally:
        session.close()


def test_connection() -> None:
    """Manual helper to verify the pressbstrlm connection."""
    try:
        with rlm_engine.connect() as conn:
            result = conn.execute(text("SELECT NOW()")).fetchone()
        print("✅ Connected to pressbstrlm")
        if result:
            print(f"   Current DB time: {result[0]}")
    except Exception as exc:  # pragma: no cover - helper for CLI use
        print("❌ pressbstrlm connection failed:", exc)


if __name__ == "__main__":  # pragma: no cover
    test_connection()

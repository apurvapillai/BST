from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker, declarative_base
import os
from dotenv import load_dotenv

# --- Load environment variables ---
load_dotenv()

DB_HOST = os.environ["DB_HOST"]
DB_USER = os.environ["DB_USER"]
DB_PASSWORD = os.environ["DB_PASSWORD"]
DB_NAME = os.environ["DB_NAME"]
DB_SSL_CA = os.environ.get("DB_SSL_CA")  # optional if local

# --- Build SQLAlchemy DB URL (mysql-connector) ---
DB_URL = f"mysql+mysqlconnector://{DB_USER}:{DB_PASSWORD}@{DB_HOST}/{DB_NAME}?charset=utf8mb4"

# --- Create engine with SSL (if provided) ---
connect_args = {"connection_timeout": 5}
if DB_SSL_CA:
    connect_args["ssl_ca"] = DB_SSL_CA

engine = create_engine(
    DB_URL,
    echo=False,        # set True for SQL debug logs
    future=True,
    connect_args=connect_args,
    pool_pre_ping=True  # keeps long-running job connections alive
)

# --- ORM setup ---
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
Base = declarative_base()

def get_db():
    """Yield a session for ETL/job/dashboard usage."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def test_connection():
    """Quick test to verify DB connection."""
    try:
        with engine.connect() as conn:
            result = conn.execute(text("SELECT NOW()")).fetchone()
            print(f"✅ Connected to MySQL '{DB_NAME}' at {DB_HOST}")
            print(f"   Current DB time: {result[0]}")
    except Exception as e:
        print("❌ Connection failed:", e)

if __name__ == "__main__":
    test_connection()

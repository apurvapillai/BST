import os
import logging
from logging.handlers import RotatingFileHandler
from flask import Flask
from routes.dashboard import dashboard_bp


def setup_logging(app):
    """Configure rotating file logs for the Flask app."""
    log_dir = os.path.join("logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "flask_app.log")

    # Rotating file handler (5 MB per file, keep 3 backups)
    handler = RotatingFileHandler(log_path, maxBytes=5 * 1024 * 1024, backupCount=3)
    handler.setLevel(logging.INFO)

    formatter = logging.Formatter(
        "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
    )
    handler.setFormatter(formatter)

    # Attach to Flask's logger
    app.logger.addHandler(handler)
    app.logger.setLevel(logging.INFO)


def create_app():
    app = Flask(
        __name__,
        template_folder=os.path.join("dashboard", "templates"),
        static_folder=os.path.join("dashboard", "static"),
    )

    # Register blueprints
    app.register_blueprint(dashboard_bp, url_prefix="/dashboard")

    # Setup logging
    setup_logging(app)
    app.logger.info("🚀 Flask app started")

    return app


if __name__ == "__main__":
    app = create_app()
    # Bind locally for testing; adjust host via FLASK_RUN_HOST if needed
    app.run(host="127.0.0.1", port=8000, debug=True)

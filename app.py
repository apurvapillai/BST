import logging
from pathlib import Path
from logging.handlers import RotatingFileHandler
from flask import Flask
from routes.assistant import assistant_bp
from routes.dashboard import dashboard_bp
from routes.insights import insights_bp
from routes.insights_api import insights_api
from routes.rlm import rlm_bp
from routes.rlm_jobs import rlm_jobs_bp
from routes.rlm_live import rlm_live_bp
from routes.rlm_press_intelligence import rlm_press_intelligence_bp
from routes.status_overview import status_overview_bp

def setup_logging(app: Flask) -> None:
    """Configure rotating file logs for the Flask app."""
    base_dir = Path(__file__).resolve().parent
    log_dir = base_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "flask_app.log"

    handler = RotatingFileHandler(
        log_path, maxBytes=5 * 1024 * 1024, backupCount=3
    )
    handler.setLevel(logging.INFO)
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )

    app.logger.addHandler(handler)
    app.logger.setLevel(logging.INFO)


def create_app() -> Flask:
    base_dir = Path(__file__).resolve().parent            # .../BST
    dash_dir = base_dir / "dashboard"                     # .../BST/dashboard
    static_dir = dash_dir / "static"
    templates_dir = dash_dir / "templates"

    app = Flask(
        __name__,
        template_folder=str(templates_dir),
        static_folder=str(static_dir),
        static_url_path="/static",  # URLs look like /static/...
    )

    # Blueprints
    app.register_blueprint(assistant_bp, url_prefix="/assistant")
    app.register_blueprint(dashboard_bp, url_prefix="/dashboard")
    app.register_blueprint(insights_bp, url_prefix="/insights")
    app.register_blueprint(insights_api, url_prefix="/api/insights")
    app.register_blueprint(rlm_bp, url_prefix="/rlm")
    app.register_blueprint(rlm_jobs_bp, url_prefix="/rlm/api")
    app.register_blueprint(rlm_live_bp, url_prefix="/rlm/live")
    app.register_blueprint(rlm_press_intelligence_bp, url_prefix="/rlm")
    app.register_blueprint(status_overview_bp)

    # Logging
    setup_logging(app)
    app.logger.info("Flask app started")
    app.logger.info(f"Templates: {app.template_folder}")
    app.logger.info(f"Static dir: {app.static_folder} -> served at {app.static_url_path}")

    return app


if __name__ == "__main__":
    app = create_app()
    # Bind to your LAN IP as requested
    # app.run(host="10.8.10.220", port=8000, debug=True)
    app.run(host="127.0.0.1", port=8000, debug=True)

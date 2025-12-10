from flask import Blueprint, render_template

insights_bp = Blueprint("insights", __name__)


@insights_bp.route("/")
def insights_home():
    return render_template("insights.html")

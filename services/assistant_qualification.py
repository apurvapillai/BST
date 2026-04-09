from __future__ import annotations

from collections import Counter
from typing import Any, Dict, List, Optional

from services.assistant_models import QualificationSummary


EXCLUSION_REASON_BELOW_MIN_FEET = "below_min_reel_feet"
EXCLUSION_REASON_OUTSIDE_REEL_SCOPE = "outside_reel_scope"
EXCLUSION_REASON_MISSING_MONITORING = "missing_monitoring"
EXCLUSION_REASON_NO_DATA = "no_data"


def build_qualification_summary(
    *,
    matched_rows: Optional[List[Dict[str, Any]]] = None,
    qualified_rows: Optional[List[Dict[str, Any]]] = None,
    exclusion_counts: Optional[Dict[str, int]] = None,
    denominator_label: Optional[str] = None,
    notes: Optional[List[str]] = None,
) -> QualificationSummary:
    matched = list(matched_rows or [])
    qualified = list(qualified_rows or [])
    counter = Counter(exclusion_counts or {})
    excluded = max(len(matched) - len(qualified), 0)
    if excluded and not counter:
        counter[EXCLUSION_REASON_NO_DATA] = excluded
    return QualificationSummary(
        matched_reels=len(matched),
        qualified_reels=len(qualified),
        excluded_reels=excluded,
        exclusion_counts=dict(counter),
        denominator_label=denominator_label or "Qualified reels in the effective analysis scope",
        notes=list(notes or []),
    )

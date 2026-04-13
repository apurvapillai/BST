from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional


RLM_REEL_FEET_PER_RANGE_UNIT = 3.20824


def _to_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, Decimal):
        return float(value)
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def compute_reel_range_units(reel_start: Any, reel_end: Any) -> Optional[float]:
    start = _to_float(reel_start)
    end = _to_float(reel_end)
    if start is None or end is None:
        return None
    delta = end - start
    if delta < 0:
        return None
    return delta


def compute_reel_feet_from_range(reel_start: Any, reel_end: Any) -> Optional[float]:
    units = compute_reel_range_units(reel_start, reel_end)
    if units is None:
        return None
    return units * RLM_REEL_FEET_PER_RANGE_UNIT

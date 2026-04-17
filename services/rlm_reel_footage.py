from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

MM_PER_FOOT = 304.8


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


def compute_feet_per_range_unit(format_length: Any) -> Optional[float]:
    format_length_value = _to_float(format_length)
    if format_length_value is None or format_length_value <= 0:
        return None
    return format_length_value / MM_PER_FOOT


def compute_reel_feet_from_range(reel_start: Any, reel_end: Any, format_length: Any) -> Optional[float]:
    units = compute_reel_range_units(reel_start, reel_end)
    if units is None:
        return None
    feet_per_range_unit = compute_feet_per_range_unit(format_length)
    if feet_per_range_unit is None:
        return None
    return units * feet_per_range_unit

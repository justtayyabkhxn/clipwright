from clipwright_engine.clip_source_map import (
    normalize_source_ranges,
    ranges_as_dicts,
    slice_source_ranges,
    source_range_bounds,
)


def test_slice_preserves_non_contiguous_mapping():
    ranges = [(10.0, 11.0), (13.0, 15.0)]
    assert slice_source_ranges(ranges, 1.0, 3.0) == [(13.0, 15.0)]
    assert slice_source_ranges(ranges, 0.5, 1.5) == [(10.5, 11.0), (13.0, 13.5)]
    assert slice_source_ranges(ranges, 0.0, 99.0) == ranges


def test_ranges_accept_pairs_and_objects_and_drop_slivers():
    assert normalize_source_ranges([[1, 2], {"start": 3, "end": 4.5}, (5, 5.01), ("x", 1)]) == [
        (1.0, 2.0),
        (3.0, 4.5),
    ]
    assert ranges_as_dicts([(1.1234567, 2.0)]) == [{"start": 1.123457, "end": 2.0}]


def test_bounds_follow_play_order_extremes():
    assert source_range_bounds([(19.92, 21.85), (10.6, 32.55)]) == (10.6, 32.55)
    assert source_range_bounds([]) is None

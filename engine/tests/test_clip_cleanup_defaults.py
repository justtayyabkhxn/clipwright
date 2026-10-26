from clipwright_engine.clip_cleanup import (
    DEFAULT_FILTERED_WORDS,
    default_filtered_words,
    DEFAULT_PAUSE_THRESHOLD_MS,
    normalize_clip_cleanup_settings,
)


def test_stored_settings_without_values_stay_off():
    # Existing tasks (resume, regenerate, expired metadata) never pick up the
    # new-task defaults.
    settings = normalize_clip_cleanup_settings()

    assert settings["cut_long_pauses"] is False
    assert settings["remove_filler_words"] is False
    assert settings["pause_threshold_ms"] == DEFAULT_PAUSE_THRESHOLD_MS == 1200
    assert normalize_clip_cleanup_settings(True, 50, True, "Basically, basically ,so")[
        "filtered_words"
    ] == ["basically", "so"]
    assert normalize_clip_cleanup_settings(pause_threshold_ms=50)["pause_threshold_ms"] == 250


def test_default_fillers_are_pure_disfluencies():
    for phrase in ("you know", "i mean", "sort of", "kind of", "like"):
        assert phrase not in DEFAULT_FILTERED_WORDS
    assert {"um", "uh"} <= set(DEFAULT_FILTERED_WORDS)


def test_default_fillers_depend_on_transcript_language():
    assert "um" in default_filtered_words("en_us")
    assert "um" in default_filtered_words("en")
    for language in ("de", "fr", "es", None, ""):
        words = default_filtered_words(language)
        assert "um" not in words
        assert "er" not in words
        assert "uh" in words
    assert "ähm" in default_filtered_words("de")
    assert "euh" in default_filtered_words("fr")

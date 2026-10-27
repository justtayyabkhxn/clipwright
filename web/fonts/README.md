# Fonts

Subtitle fonts that Clipwright shows in the UI and uses when it renders clips.

## How it works

- `GET /api/fonts` lists the files in this directory plus the signed-in user's uploaded fonts
  (`fonts/{userId}/` in storage).
- The worker passes this directory to the render engine first in `fonts_dirs`, so a bundled font
  wins over a user font with the same name.
- Each font's info popover shows the languages covered by its actual glyphs, including uploaded
  fonts. The API returns these language tags in `supported_languages`; `null` means the coverage
  check was unavailable.
- A font that lacks a caption's characters falls back to a system font through libass, which can
  change the look. Install Fontconfig and the Noto packages (core, CJK, emoji) with your OS package
  manager for good fallbacks, and preview non-English captions before exporting.

## Supported formats

- `.ttf`
- `.otf`

## Adding a font

1. Copy the font file into this directory.
2. Restart `pnpm dev` if the new file does not appear immediately.
3. Confirm the font is listed by the app or `GET /api/fonts`.

## Notes

- Keep file names stable if they are already referenced by saved tasks or user defaults.
- Large font collections make the picker harder to use, so prefer a curated set.
- Source and licensing notes for bundled fonts go in [`SOURCES.md`](./SOURCES.md).

# Space Grotesk (self-hosted web subsets)

The dashboard logo and headings use Space Grotesk at weights 500 and 700. The
browser loads the four same-origin files in this directory (hashed by Vite at
build time); the dashboard makes no request to Google Fonts (#525).

| File | Weight | Subset |
| --- | --- | --- |
| `space-grotesk-latin-500.woff2` | 500 | `latin` (includes `ó`) |
| `space-grotesk-latin-700.woff2` | 700 | `latin` (includes `ó`) |
| `space-grotesk-latin-ext-500.woff2` | 500 | `latin-ext` (includes `ą ć ę ł ń ś ź ż`) |
| `space-grotesk-latin-ext-700.woff2` | 700 | `latin-ext` (includes `ą ć ę ł ń ś ź ż`) |

`SHA256SUMS` lists the checksums of these files; verify with
`sha256sum -c SHA256SUMS`. Characters outside the two subsets (for example
Vietnamese letters) fall back to the system font in the `--font-logo` stack.

## Source and license

- Upstream: <https://github.com/floriankarsten/space-grotesk>, release `2.0.0`
  (tag commit `7220f5d04813fe83babe76d4fd23e02275021280`), asset
  `SpaceGrotesk-2.0.0.zip`, SHA-256
  `53b415577d4139248555300710bea0d268c7a5be67b93de53b716a9736cabffd`.
- Inputs from that archive:
  - `woff2/static/SpaceGrotesk-Medium.woff2`, SHA-256
    `f20a85be4c8a74ddad94d46fcce503666498855e5a87755d75cd728d801bbe58`
  - `woff2/static/SpaceGrotesk-Bold.woff2`, SHA-256
    `06d705cebbab916f0c0fe82b6c6f4cae06aa07fd6f5ee078421206040326ef63`
- License: SIL Open Font License 1.1, copyright 2020 The Space Grotesk Project
  Authors. The license declares no Reserved Font Name, so the subsets keep the
  upstream family name. The unmodified license text from the same release
  (SHA-256 `564ce565c371c5e5bbf286006565a7c9aa55a9f56e7ca58d56e05d649dd61a72`)
  is `../../../public/fonts/space-grotesk/OFL.txt`; Vite copies it to
  `dist/fonts/space-grotesk/OFL.txt` so it ships with the UI assets. The
  copyright and license strings are also kept in each font file's `name`
  table.

The files here are modified versions (subsets) of that software, produced with
the commands below. They contain no glyph or outline changes.

## Regenerating

Requires `fonttools` 4.67.0 and `brotli` 1.2.0 (what produced the checked-in
files). Download and extract the release archive, then from its
`woff2/static` directory:

```sh
LATIN="U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD"
LATIN_EXT="U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF"
for entry in 500:Medium 700:Bold; do
  weight=${entry%%:*}; name=${entry##*:}
  pyftsubset "SpaceGrotesk-$name.woff2" --unicodes="$LATIN" --flavor=woff2 \
    --layout-features='*' --name-IDs='*' --name-languages='*' --no-hinting \
    --output-file="space-grotesk-latin-$weight.woff2"
  pyftsubset "SpaceGrotesk-$name.woff2" --unicodes="$LATIN_EXT" --flavor=woff2 \
    --layout-features='*' --name-IDs='*' --name-languages='*' --no-hinting \
    --output-file="space-grotesk-latin-ext-$weight.woff2"
done
```

The `unicode-range` values are those of the `latin` and `latin-ext` subsets in
the Google Fonts stylesheet for this family (read on 2026-10-15), and are
repeated in the `@font-face` rules in `src/index.css`. Hinting is dropped, as is
usual for web subsets: the upstream static files carry `ttfautohint`
instructions that make the four subsets about a third larger (about 81 KB
instead of 55 KB).

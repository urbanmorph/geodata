#!/usr/bin/env python3
"""Static DM Sans instances for the OG card renderer, plus title widths.

resvg (web/functions/lib/og-render.ts) cannot apply a variable font's
weight axis, so every weight rendered as Regular and the wordmark looked
thin. This cuts fixed instances from the variable DM Sans
(web/scripts/fonts/DMSans-variable.ttf) at the three weights the cards use, and writes the advance widths
of printable ASCII at the title weight, so og-template.ts can wrap titles
by real width instead of a character count.

Idempotent: same input font, same output bytes. Run from anywhere:
    python3 scripts/gen_og_fonts.py
"""

import io
import json
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
SRC = (
    ROOT / "web" / "scripts" / "fonts" / "DMSans-variable.ttf"
)  # source only, not deployed
OUT = ROOT / "web" / "public"
WIDTHS = ROOT / "web" / "functions" / "lib" / "og-widths.json"
WEIGHTS = {"400": 400, "600": 600, "800": 800}
TITLE_WEIGHT = 600
STYLES = {400: "Regular", 600: "SemiBold", 800: "ExtraBold"}


def instance(wght: int) -> TTFont:
    font = instantiateVariableFont(
        TTFont(SRC, recalcTimestamp=False), {"wght": wght, "opsz": 14}
    )
    # One family, told apart by weight class: resvg (fontdb) matches
    # font-family="DM Sans" + font-weight against these, and an instance named
    # "DM Sans 14pt SemiBold" would never match, falling back to one weight.
    style = STYLES[wght]
    name = font["name"]
    name.removeNames(nameID=16)
    name.removeNames(nameID=17)
    for nid, value in (
        (1, "DM Sans"),
        (2, "Regular"),
        (4, f"DM Sans {style}"),
        (6, f"DMSans-{style}"),
    ):
        name.setName(value, nid, 3, 1, 0x409)
        name.setName(value, nid, 1, 0, 0)
    font["OS/2"].usWeightClass = wght
    # Latin + Latin-1 + punctuation the cards use (·, …, ’, –, ₹). Keeps each file small.
    opts = Options()
    opts.layout_features = ["kern", "liga"]
    sub = Subsetter(opts)
    sub.populate(
        unicodes=list(range(0x20, 0x7F))
        + list(range(0xA0, 0x180))
        + [0x2018, 0x2019, 0x201C, 0x201D, 0x2013, 0x2014, 0x2026, 0x00B7, 0x20B9]
    )
    sub.subset(font)
    return font


def main() -> None:
    for name, wght in WEIGHTS.items():
        font = instance(wght)
        font.recalcTimestamp = False  # byte-stable output: no save-time timestamp
        buf = io.BytesIO()
        font.save(buf)
        path = OUT / f"og-font-{name}.ttf"
        data = buf.getvalue()
        if path.exists() and path.read_bytes() == data:
            print(f"unchanged {path.name}", flush=True)
        else:
            path.write_bytes(data)
            print(f"wrote {path.name} ({len(data) // 1024} KB)", flush=True)
        if wght == TITLE_WEIGHT:
            upm = font["head"].unitsPerEm
            cmap = font.getBestCmap()
            hmtx = font["hmtx"]
            widths = {
                chr(c): round(hmtx[cmap[c]][0] / upm, 4)
                for c in range(0x20, 0x7F)
                if c in cmap
            }
            text = (
                json.dumps(
                    {"weight": wght, "em": widths}, ensure_ascii=False, sort_keys=True
                )
                + "\n"
            )
            if not WIDTHS.exists() or WIDTHS.read_text() != text:
                WIDTHS.write_text(text)
                print(f"wrote {WIDTHS.name}", flush=True)


if __name__ == "__main__":
    main()

"""The ANote editor, drawn frame by frame and saved as an animated GIF.

A mockup, not a screenshot: every pixel here is drawn by this script, so the
README has something moving in it that no capture session has to be repeated to
regenerate. Run it with the output directory as the only argument.
"""
import sys

from PIL import Image, ImageDraw, ImageFont

SCALE = 2
W, H = 900, 430

SF = "/System/Library/Fonts/SFNS.ttf"


def font(size, weight=None):
    f = ImageFont.truetype(SF, size * SCALE)
    if weight:
        try:
            f.set_variation_by_name(weight)
        except Exception:
            pass
    return f


F = {
    "h1": font(25, "Bold"),
    "body": font(14),
    "small": font(12),
    "tiny": font(10, "Semibold"),
    "tab": font(12),
    "menu": font(13),
    "hint": font(11),
    "cell": font(12),
    "cellb": font(12, "Semibold"),
    "glyph": font(9, "Bold"),
}

C = {
    "editor": "#1e1e1e",
    "chrome": "#252526",
    "edge": "#1a1a1a",
    "border": "#333338",
    "text": "#d7d7d9",
    "dim": "#8b8b90",
    "faint": "#6a6a70",
    "head": "#f0f0f2",
    "sel": "#37373d",
    "accent": "#4c8ef7",
    "menu": "#2a2a2c",
    "menub": "#4a4a52",
    "cell": "#2b2b2e",
    "grid": "#3d3d44",
    "white": "#ffffff",
}

SIDEBAR = 196
TABBAR = 36
PAD = SIDEBAR + 54
LINE = 206


def s(v):
    return int(round(v * SCALE))


def text(d, xy, t, f, fill):
    d.text((s(xy[0]), s(xy[1])), t, font=f, fill=fill)


def wide(t, f):
    return f.getlength(t) / SCALE


def note_glyph(d, x, y, size=13, md=False):
    d.rounded_rectangle([s(x), s(y), s(x + size), s(y + size)], radius=s(3),
                        fill="#c9c9cd" if md else "#e2e2e4")
    text(d, (x + size / 2 - wide("A", F["glyph"]) / 2, y + 0.5), "A", F["glyph"], C["chrome"])
    d.line([s(x + 3), s(y + size - 3.5), s(x + size - 3), s(y + size - 3.5)],
           fill=C["chrome"], width=s(1))


def chrome(d):
    d.rectangle([0, 0, s(SIDEBAR), s(H)], fill=C["chrome"])
    d.rectangle([s(SIDEBAR), 0, s(W), s(TABBAR)], fill=C["chrome"])
    d.rectangle([s(SIDEBAR), 0, s(SIDEBAR + 168), s(TABBAR)], fill=C["editor"])
    d.line([s(SIDEBAR), s(1), s(SIDEBAR + 168), s(1)], fill=C["accent"], width=s(2))
    note_glyph(d, SIDEBAR + 16, 12)
    text(d, (SIDEBAR + 36, 10), "Welcome.note", F["tab"], C["text"])
    text(d, (SIDEBAR + 190, 10), "README.md", F["tab"], C["faint"])
    d.line([s(SIDEBAR), s(TABBAR), s(W), s(TABBAR)], fill=C["border"], width=s(1))
    d.line([s(SIDEBAR), 0, s(SIDEBAR), s(H)], fill=C["edge"], width=s(1))

    text(d, (16, 13), "EXPLORER", F["tiny"], C["dim"])
    text(d, (16, 44), "SAMPLE", F["tiny"], C["dim"])
    rows = [
        (0, "▾", "Tour", None),
        (1, None, "1. Blocks.note", "note"),
        (1, None, "2. Pictures.note", "note"),
        (0, "▸", "Examples", None),
        (0, None, "Welcome.note", "active"),
        (0, None, "Markdown.md", "md"),
    ]
    y = 70
    for depth, arrow, label, kind in rows:
        x = 16 + depth * 14
        if kind == "active":
            d.rectangle([0, s(y - 5), s(SIDEBAR) - SCALE, s(y + 17)], fill=C["sel"])
        if arrow:
            if arrow == "▾":
                d.polygon([(s(x), s(y + 6)), (s(x + 8), s(y + 6)), (s(x + 4), s(y + 11))],
                          fill=C["faint"])
            else:
                d.polygon([(s(x + 1), s(y + 3)), (s(x + 1), s(y + 11)), (s(x + 6), s(y + 7))],
                          fill=C["faint"])
            text(d, (x + 15, y), label, F["small"], C["text"])
        else:
            note_glyph(d, x + 15, y + 1, md=(kind == "md"))
            text(d, (x + 34, y), label, F["small"],
                 C["head"] if kind == "active" else C["text"])
        y += 26


def check(d, x, y, label, done):
    box = [s(x), s(y + 1), s(x + 14), s(y + 15)]
    if done:
        d.rounded_rectangle(box, radius=s(3), fill=C["accent"])
        d.line([s(x + 3.5), s(y + 8), s(x + 6), s(y + 11), s(x + 10.5), s(y + 5)],
               fill=C["white"], width=s(2), joint="curve")
        text(d, (x + 24, y), label, F["body"], C["dim"])
        d.line([s(x + 24), s(y + 9), s(x + 24 + wide(label, F["body"])), s(y + 9)],
               fill=C["dim"], width=s(1))
    else:
        d.rounded_rectangle(box, radius=s(3), outline=C["faint"], width=s(1))
        text(d, (x + 24, y), label, F["body"], C["text"])


def note_head(d):
    text(d, (PAD, 56), "Sprint 14 planning", F["h1"], C["head"])
    text(d, (PAD, 98), "Notes from the Monday sync — one file, committed beside", F["body"], C["text"])
    text(d, (PAD, 120), "the code it talks about.", F["body"], C["text"])
    check(d, PAD, 154, "Ship the studio behind a flag", True)
    check(d, PAD, 180, "Write the README", False)


def caret(d, x, y, h=19):
    d.line([s(x), s(y), s(x), s(y + h)], fill="#eaeaec", width=s(2))


MENU = [
    ("heading", "Heading 2", "A section"),
    ("list", "Bulleted list", "A list"),
    ("table", "Table", "Rows and columns"),
    ("image", "Image", "From a file"),
    ("draw", "Drawing", "Excalidraw"),
]


def icon(d, kind, x, y, w=22, h=20):
    """The menu's own glyphs — drawn, because SF Symbols are not in the font."""
    ink = C["text"]
    cx, cy = x + w / 2, y + h / 2
    if kind == "heading":
        text(d, (cx - wide("H", F["hint"]) / 2, cy - 7), "H", F["hint"], ink)
    elif kind == "list":
        for i, ly in enumerate((cy - 5, cy, cy + 5)):
            d.ellipse([s(x + 5), s(ly - 1), s(x + 7), s(ly + 1)], fill=ink)
            d.line([s(x + 9.5), s(ly), s(x + w - 4), s(ly)], fill=ink, width=s(1))
    elif kind == "table":
        d.rectangle([s(x + 4.5), s(cy - 6.5), s(x + w - 4.5), s(cy + 6.5)],
                    outline=ink, width=s(1))
        d.line([s(x + 4.5), s(cy - 2), s(x + w - 4.5), s(cy - 2)], fill=ink, width=s(1))
        d.line([s(cx), s(cy - 6.5), s(cx), s(cy + 6.5)], fill=ink, width=s(1))
    elif kind == "image":
        d.rectangle([s(x + 4.5), s(cy - 6), s(x + w - 4.5), s(cy + 6)],
                    outline=ink, width=s(1))
        d.ellipse([s(x + 7), s(cy - 4), s(x + 10), s(cy - 1)], fill=ink)
        d.polygon([(s(x + 6), s(cy + 5)), (s(cx), s(cy - 1)), (s(x + w - 5.5), s(cy + 5))],
                  fill=ink)
    elif kind == "draw":
        d.line([s(x + 5), s(cy + 5), s(x + 9), s(cy - 2), s(cx + 1), s(cy + 3),
                s(x + w - 5), s(cy - 6)], fill=ink, width=s(1), joint="curve")


def menu(d, x, y, typed, selected, grow=1.0):
    """The slash menu, filtered by whatever follows the slash."""
    items = [m for m in MENU if typed[1:].lower() in m[1].lower()] if len(typed) > 1 else MENU
    w, ih = 268, 34
    h = int(len(items) * ih * grow) + 12
    d.rounded_rectangle([s(x), s(y), s(x + w), s(y + h)], radius=s(8),
                        fill=C["menu"], outline=C["menub"], width=s(1))
    if grow < 1.0:
        return
    iy = y + 6
    for i, (kind, label, hint) in enumerate(items):
        if i == selected:
            d.rounded_rectangle([s(x + 5), s(iy), s(x + w - 5), s(iy + ih - 2)],
                                radius=s(5), fill=C["sel"])
        d.rounded_rectangle([s(x + 12), s(iy + 6), s(x + 34), s(iy + 26)], radius=s(4),
                            fill="#1f1f21", outline=C["menub"], width=s(1))
        icon(d, kind, x + 12, iy + 6)
        text(d, (x + 44, iy + 8), label, F["menu"], C["head"] if i == selected else C["text"])
        text(d, (x + w - 12 - wide(hint, F["hint"]), iy + 10), hint, F["hint"], C["faint"])
        iy += ih


COLS = [(230, "Task"), (120, "Owner"), (110, "Status")]
ROWS = [
    ("Studio behind a flag", "Duong", "Done"),
    ("README, with a demo", "Duong", "In review"),
]


def table(d, x, y, cells):
    """`cells` is how many of the nine are filled — the table typing itself in."""
    rh = 34
    total = sum(c[0] for c in COLS)
    d.rectangle([s(x), s(y), s(x + total), s(y + rh)], fill=C["cell"])
    d.rounded_rectangle([s(x), s(y), s(x + total), s(y + rh * 3)], radius=s(4),
                        outline=C["grid"], width=s(1))
    cx = x
    for w, _ in COLS[:-1]:
        cx += w
        d.line([s(cx), s(y), s(cx), s(y + rh * 3)], fill=C["grid"], width=s(1))
    for r in (1, 2):
        d.line([s(x), s(y + rh * r), s(x + total), s(y + rh * r)], fill=C["grid"], width=s(1))

    n = 0
    for r in range(3):
        cx = x
        for c, (w, header) in enumerate(COLS):
            if n < cells:
                label = header if r == 0 else ROWS[r - 1][c]
                f = F["cellb"] if r == 0 else F["cell"]
                fill = C["head"] if r == 0 else C["text"]
                if label == "Done":
                    d.rounded_rectangle([s(cx + 12), s(y + rh * r + 9), s(cx + 12 + wide(label, f) + 16), s(y + rh * r + 26)],
                                        radius=s(8), fill="#20402c")
                    text(d, (cx + 20, y + rh * r + 10), label, f, "#7ddc9a")
                else:
                    text(d, (cx + 12, y + rh * r + 9), label, f, fill)
            elif n == cells:
                caret(d, cx + 13, y + rh * r + 8, 17)
            n += 1
            cx += w


def frame(typed="", show_menu=False, selected=0, grow=1.0, cells=None, caret_on=True):
    im = Image.new("RGB", (s(W), s(H)), C["editor"])
    d = ImageDraw.Draw(im)
    chrome(d)
    note_head(d)
    if cells is None:
        text(d, (PAD, LINE), typed, F["body"], C["text"])
        if caret_on:
            caret(d, PAD + wide(typed, F["body"]) + 2, LINE - 1)
        if show_menu:
            menu(d, PAD, LINE + 28, typed, selected, grow)
    else:
        table(d, PAD, LINE, cells)
    return im


def main(out):
    frames, delays = [], []

    def add(im, ms):
        frames.append(im)
        delays.append(ms)

    # An empty block, waiting.
    for on in (True, False, True):
        add(frame(caret_on=on), 480)
    # `/`, and the menu it opens.
    add(frame("/"), 260)
    add(frame("/", True, grow=0.25), 60)
    add(frame("/", True, grow=0.7), 60)
    add(frame("/", True), 620)
    # Which is a filter, not a list to scroll.
    for typed, ms in (("/t", 200), ("/ta", 200), ("/tab", 760)):
        add(frame(typed, True), ms)
    # Enter, and the block is there to type into.
    add(frame(cells=0), 320)
    for n in range(1, 10):
        add(frame(cells=n), 190)
    add(frame(cells=9), 2000)

    montage = Image.new("RGB", (frames[0].width, frames[0].height * len(frames)))
    for i, f in enumerate(frames):
        montage.paste(f, (0, f.height * i))
    master = montage.quantize(colors=200, method=Image.MEDIANCUT)
    out_frames = [f.quantize(colors=200, palette=master) for f in frames]
    out_frames[0].save(f"{out}/editor.gif", save_all=True, append_images=out_frames[1:],
                       duration=delays, loop=0, optimize=True, disposal=1)
    print("frames", len(out_frames))


main(sys.argv[1])

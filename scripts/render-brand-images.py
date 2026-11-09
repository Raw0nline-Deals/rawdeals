"""Regenerate the social image and apple touch icon. Requires Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SANS = "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf"
SANS_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"
SERIF_ITALIC = "/usr/share/fonts/truetype/liberation/LiberationSerif-BoldItalic.ttf"
SERIF_BOLD = "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf"

PAPER = (243, 239, 231)
INK = (26, 24, 20)
COPPER = (224, 122, 76)
PINE = (30, 70, 56)


def og():
    image = Image.new("RGB", (1200, 630), PAPER)
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 18, 630), fill=COPPER)
    draw.rounded_rectangle((88, 210, 184, 306), radius=22, fill=INK)
    mark = ImageFont.truetype(SERIF_BOLD, 72)
    draw.text((136, 258), "R", font=mark, fill=COPPER, anchor="mm")
    raw = ImageFont.truetype(SERIF_ITALIC, 86)
    deals = ImageFont.truetype(SANS_BOLD, 78)
    draw.text((212, 198), "Raw", font=raw, fill=INK)
    raw_box = draw.textbbox((212, 198), "Raw", font=raw)
    draw.text((raw_box[2] - 6, 206), "Deals", font=deals, fill=INK)
    sub = ImageFont.truetype(SANS, 36)
    draw.text((216, 330), "Daily Amazon deals from Raw0nline", font=sub, fill=PINE)
    place = ImageFont.truetype(SANS_BOLD, 24)
    draw.text((216, 400), "SAN ANTONIO, TX", font=place, fill=(74, 69, 62))
    image.save(ROOT / "images" / "og.png", optimize=True)


def apple():
    image = Image.new("RGB", (180, 180), INK)
    draw = ImageDraw.Draw(image)
    mark = ImageFont.truetype(SERIF_BOLD, 120)
    draw.text((90, 98), "R", font=mark, fill=COPPER, anchor="mm")
    image.save(ROOT / "images" / "apple-touch-icon.png", optimize=True)


if __name__ == "__main__":
    og()
    apple()
    print("wrote images/og.png and images/apple-touch-icon.png")

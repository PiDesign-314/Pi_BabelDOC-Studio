"""Browser-free contract tests for web/hand-underline.js.

The module is a classic script, so there is nothing to import from Python.
Instead we execute it in Node (no DOM is required for the geometry API),
read the geometry back as JSON, and assert the deterministic contract that
the viewer relies on.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "web" / "hand-underline.js"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not MODULE.is_file(),
    reason="needs node and web/hand-underline.js",
)

HARNESS = r"""
"use strict";
require(process.argv[2]);
const HU = globalThis.StudioHandUnderline;
if (!HU) {
  console.error("StudioHandUnderline missing");
  process.exit(2);
}

const opts = (style, extra) =>
  Object.assign({ width: 392, height: 29.3, style, seed: "item-7f3a", lineIndex: 0 }, extra || {});
const geometry = (style, extra) => {
  const g = HU.describe(opts(style, extra));
  return {
    style: g.style,
    points: g.points,
    d: g.d,
    ghostD: g.ghostD,
    strokeWidth: g.strokeWidth,
    ghostWidth: g.ghostWidth,
    opacity: g.opacity,
    ghostOpacity: g.ghostOpacity,
    seed: g.seed,
    lineIndex: g.lineIndex,
  };
};

const report = {
  version: 1,
  keys: Object.keys(HU).sort(),
  order: HU.ORDER.slice(),
  defaultStyle: HU.DEFAULT_STYLE,
  presets: HU.ORDER.map((id) => {
    const p = HU.PRESETS[id];
    return {
      id: p.id,
      label: p.label,
      level: p.level,
      amplitude: p.amplitude,
      stroke: p.stroke,
      opacity: p.opacity,
      points: p.points,
    };
  }),
  aliases: {
    soft: HU.PRESETS.soft && HU.PRESETS.soft.id,
    natural: HU.PRESETS.natural && HU.PRESETS.natural.id,
    strong: HU.PRESETS.strong && HU.PRESETS.strong.id,
    enumerable: Object.keys(HU.PRESETS),
  },
  isHand: {
    soft: HU.isHandStyle("hand-soft"),
    natural: HU.isHandStyle("hand-natural"),
    strong: HU.isHandStyle("hand-strong"),
    legacy: HU.isHandStyle("hand"),
    padded: HU.isHandStyle(" HAND "),
    marker: HU.isHandStyle("marker"),
    underline: HU.isHandStyle("underline"),
    empty: HU.isHandStyle(""),
    missing: HU.isHandStyle(null),
  },
  normalize: ["hand", " HAND ", "hand-natural", "hand-soft", "hand-strong", "marker"].map((s) =>
    HU.normalizeStyle(s)
  ),
  stable: HU.pathData(opts("hand-natural")) === HU.pathData(opts("hand-natural")),
  lineDiffers:
    HU.pathData(opts("hand-natural")) !== HU.pathData(opts("hand-natural", { lineIndex: 1 })),
  seedDiffers:
    HU.pathData(opts("hand-natural")) !== HU.pathData(opts("hand-natural", { seed: "other" })),
  handAlias:
    HU.pathData(opts("hand")) === HU.pathData(opts("hand-natural")),
  fallbackNatural: HU.pathData(opts("marker")) === HU.pathData(opts("hand-natural")),
  geometries: ["hand-soft", "hand-natural", "hand-strong"].map((style) => geometry(style)),
  widthInvariance: ["hand-soft", "hand-natural", "hand-strong"].map((style) => {
    const small = geometry(style, { width: 180, height: 22 });
    const large = geometry(style, { width: 980, height: 22 });
    return {
      style,
      ySmall: small.points.map((p) => p.y),
      yLarge: large.points.map((p) => p.y),
      xSmall: small.points.map((p) => p.x),
      xLarge: large.points.map((p) => p.x),
    };
  }),
  heightScaling: ["hand-soft", "hand-natural", "hand-strong"].map((style) => ({
    style,
    small: geometry(style, { width: 300, height: 20 }),
    large: geometry(style, { width: 300, height: 40 }),
  })),
  lineIndependence: ["hand-natural", "hand-strong"].map((style) => ({
    style,
    line0: HU.describe(opts(style, { lineIndex: 0, width: 640, height: 24 })).d,
    line1: HU.describe(opts(style, { lineIndex: 1, width: 640, height: 24 })).d,
    line2: HU.describe(opts(style, { lineIndex: 2, width: 640, height: 24 })).d,
  })),
  tiny: HU.describe({ width: 3, height: 30, style: "hand-natural", seed: "tiny", lineIndex: 0 }),
  thinBand: HU.describe({ width: 1200, height: 8, style: "hand-strong", seed: "flat", lineIndex: 0 }),
  renderNull: HU.render(null, opts("hand-natural")),
};

process.stdout.write(JSON.stringify(report));
"""


@pytest.fixture(scope="module")
def report(tmp_path_factory: pytest.TempPathFactory) -> dict:
    harness = tmp_path_factory.mktemp("hand-underline") / "harness.js"
    harness.write_text(HARNESS, encoding="utf-8")
    proc = subprocess.run(
        [shutil.which("node"), str(harness), str(MODULE)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    assert proc.returncode == 0, f"node harness failed: {proc.stderr}"
    return json.loads(proc.stdout)


def test_public_api_and_presets(report):
    assert {"PRESETS", "DEFAULT_STYLE", "isHandStyle", "normalizeStyle", "pathData", "render"} <= set(
        report["keys"]
    )
    assert report["order"] == ["hand-soft", "hand-natural", "hand-strong"]
    assert report["defaultStyle"] == "hand-natural"
    presets = {p["id"]: p for p in report["presets"]}
    assert list(presets) == ["hand-soft", "hand-natural", "hand-strong"]
    assert presets["hand-soft"]["label"] == "轻微手绘"
    assert presets["hand-natural"]["label"] == "自然手绘"
    assert presets["hand-strong"]["label"] == "明显手绘"
    assert [presets[key]["amplitude"] for key in presets] == [0.06, 0.1, 0.16]
    assert [presets[key]["stroke"] for key in presets] == [1.6, 2.0, 2.4]
    assert [presets[key]["points"] for key in presets] == [3, 4, 5]
    assert all(presets[key]["opacity"] == 0.9 for key in presets)
    assert report["aliases"] == {
        "soft": "hand-soft",
        "natural": "hand-natural",
        "strong": "hand-strong",
        "enumerable": ["hand-soft", "hand-natural", "hand-strong"],
    }


def test_style_helpers(report):
    assert report["isHand"] == {
        "soft": True,
        "natural": True,
        "strong": True,
        "legacy": True,
        "padded": True,
        "marker": False,
        "underline": False,
        "empty": False,
        "missing": False,
    }
    assert report["normalize"] == [
        "hand-natural",
        "hand-natural",
        "hand-natural",
        "hand-soft",
        "hand-strong",
        "marker",
    ]
    # "hand" is an alias, not a fourth preset: identical geometry.
    assert report["handAlias"] is True
    # Unknown styles fall back to the documented default rather than exploding.
    assert report["fallbackNatural"] is True


def test_shapes_are_deterministic_per_seed_and_line(report):
    assert report["stable"] is True
    assert report["lineDiffers"] is True
    assert report["seedDiffers"] is True
    for item in report["lineIndependence"]:
        assert len({item["line0"], item["line1"], item["line2"]}) == 3


def test_geometry_is_a_smooth_low_frequency_curve(report):
    for geom in report["geometries"]:
        points = geom["points"]
        assert geom["d"].startswith("M ") and " C " in geom["d"]
        assert geom["ghostD"] and geom["ghostD"] != geom["d"]
        assert 3 <= len(points) <= 5
        # x is strictly increasing so the path never folds back on itself
        xs = [point["x"] for point in points]
        assert all(b > a for a, b in zip(xs, xs[1:]))
        # knots are drawn under the text: never above 85% of the band, and the
        # tail may hang a hair below the band to clear Latin descenders
        ys = [point["y"] for point in points]
        assert all(0.84 * 29.3 <= y <= 1.04 * 29.3 for y in ys)
        # a visible but restrained excursion
        assert 0.6 <= max(ys) - min(ys) <= 0.16 * 29.3 + 0.4
    widths = [geom["strokeWidth"] for geom in report["geometries"]]
    assert widths[0] < widths[1] < widths[2]
    assert report["geometries"][1]["opacity"] == 0.9
    assert report["geometries"][1]["ghostOpacity"] < report["geometries"][1]["opacity"]


def test_amplitude_does_not_grow_with_line_width(report):
    for item in report["widthInvariance"]:
        # identical seed/style/height: y only depends on the (unchanged) height
        assert item["ySmall"] == item["yLarge"]
        # the extra 800px of line is all horizontal: the tails only grow by the
        # (unchanged) overshoot on each side
        assert item["xLarge"][-1] - item["xSmall"][-1] > 799
        assert item["xSmall"][0] > -40 and item["xLarge"][0] > -40


def test_shape_scales_proportionally_with_height(report):
    for item in report["heightScaling"]:
        small = item["small"]["points"]
        large = item["large"]["points"]
        assert len(small) == len(large)
        for low, high in zip(small, large):
            # the wave itself is proportional to the band height
            assert high["y"] == pytest.approx(low["y"] * 2, abs=0.03)
            # the end overshoot scales with the band too, so the x envelope
            # widens slightly while the interior stays put
            assert high["x"] == pytest.approx(low["x"], abs=4.0)
        assert large[0]["x"] <= small[0]["x"]
        assert large[-1]["x"] >= small[-1]["x"]


def test_degenerate_bands_stay_usable(report):
    tiny = report["tiny"]
    assert tiny["points"] == []
    assert tiny["d"].startswith("M 0 ")
    thin = report["thinBand"]
    assert " C " in thin["d"]
    assert 3 <= len(thin["points"]) <= 5
    assert all(0 <= point["y"] <= 8.4 for point in thin["points"])
    assert report["renderNull"] is None


def test_module_has_no_paint_time_randomness():
    import re

    source = MODULE.read_text(encoding="utf-8")
    code = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    code = re.sub(r"//[^\n]*", "", code)
    assert "Math.random" not in code
    assert "Date.now" not in code
    assert "performance.now" not in code
    assert "window.StudioHandUnderline" in source

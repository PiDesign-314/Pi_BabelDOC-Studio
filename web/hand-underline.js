/* ------------------------------------------------------------------ *
 *  BabelDOC Studio — hand-drawn underline geometry
 *  A dependency-free classic script that turns one annotation band
 *  (width x height, in CSS px) into a deterministic, low-frequency
 *  hand-drawn underline path.
 *
 *  Three presets:
 *    hand-soft     轻微手绘   amplitude 0.06 · stroke 1.6px
 *    hand-natural  自然手绘   amplitude 0.10 · stroke 2.0px   (default)
 *    hand-strong   明显手绘   amplitude 0.16 · stroke 2.4px
 *  The legacy style id "hand" aliases to hand-natural.
 *
 *  Determinism: every shape is derived from a seed (usually the item id)
 *  and the physical line index through an FNV-1a hash + LCG. No
 *  Math.random() at paint time, so repaint / reload / zoom / page switch
 *  keep the same annotation stable.
 *
 *  Public API (window.StudioHandUnderline):
 *    PRESETS                       id -> frozen preset description
 *    DEFAULT_STYLE                 "hand-natural"
 *    ORDER                         ["hand-soft", "hand-natural", "hand-strong"]
 *    isHandStyle(style)            true for the three presets and "hand"
 *    normalizeStyle(style)         "hand" -> "hand-natural", trimmed/lowercased
 *    pathData({width,height,...})  the main cubic-Bezier path data string
 *    describe({...})               full geometry (points, widths, opacity)
 *    render(svg, {...})            paint one underline into an <svg>
 *
 *  render(svg, { width, height, style, seed, lineIndex, color })
 *    width/height   band size in CSS px (the SVG is given that viewBox)
 *    style          preset id or "hand"
 *    seed           item id string (hashed) or a number
 *    lineIndex      0-based physical line index inside that item
 *    color          optional stroke colour; when omitted the nearest
 *                   --mark-color custom property is used, else currentColor
 *    Returns the main <path> element (or null for an unusable <svg>).
 * ------------------------------------------------------------------ */
(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var DEFAULT_STYLE = "hand-natural";
  var ORDER = ["hand-soft", "hand-natural", "hand-strong"];
  /* Stroke widths are quoted at a 20px band; they grow with the band. */
  var BASE_HEIGHT = 20;
  var MIN_DRAWABLE_WIDTH = 5;
  var MIN_DRAWABLE_HEIGHT = 4;

  var PRESET_DEFS = {
    "hand-soft": {
      id: "hand-soft",
      label: "轻微手绘",
      level: "soft",
      /* wave amplitude as a fraction of the band height; the curve uses about
         70% of this budget so the line stays calm */
      amplitude: 0.06,
      stroke: 1.6,
      opacity: 0.9,
      /* nominal stroke centre, as a fraction of band height: low enough to
         clear Latin descenders, still inside the reader's line gap */
      baseline: 0.94,
      tilt: 0.06,
      tension: 0.68,
      points: 3,
      /* start/end overshoot as a fraction of band height */
      overshoot: 0.12,
      tail: 0.1,
      ghost: 0.16,
    },
    "hand-natural": {
      id: "hand-natural",
      label: "自然手绘",
      level: "natural",
      amplitude: 0.1,
      stroke: 2.0,
      opacity: 0.9,
      baseline: 0.95,
      tilt: 0.09,
      tension: 0.8,
      points: 4,
      overshoot: 0.15,
      tail: 0.1,
      ghost: 0.2,
    },
    "hand-strong": {
      id: "hand-strong",
      label: "明显手绘",
      level: "strong",
      amplitude: 0.16,
      stroke: 2.4,
      opacity: 0.9,
      baseline: 0.96,
      tilt: 0.12,
      tension: 0.9,
      points: 5,
      overshoot: 0.18,
      tail: 0.1,
      ghost: 0.24,
    },
  };

  /* ------------------------------------------------------------- seed -- */
  function hashText(text) {
    var hash = 2166136261;
    for (var i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /* Mix the line index in and avalanche, so adjacent lines of one item do
     not merely "scroll" the same wave. */
  function mixSeed(seed, lineIndex) {
    var value = seed >>> 0;
    value ^= Math.imul((lineIndex | 0) + 1, 0x9e3779b1) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x85ebca6b) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 0xc2b2ae35) >>> 0;
    value ^= value >>> 16;
    return value >>> 0;
  }

  function makeRandom(seed) {
    var state = (seed >>> 0) || 0x1a2b3c4d;
    return function random() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  /* --------------------------------------------------------- helpers -- */
  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  function round2(value) {
    return Math.round(value * 100) / 100;
  }

  function normalizeStyle(style) {
    if (style == null) return "";
    var key = String(style).trim().toLowerCase();
    if (key === "hand") return DEFAULT_STYLE;
    return key;
  }

  function isHandStyle(style) {
    return Object.prototype.hasOwnProperty.call(PRESETS, normalizeStyle(style));
  }

  function readOptions(options) {
    var opts = options || {};
    var style = normalizeStyle(opts.style);
    var preset = Object.prototype.hasOwnProperty.call(PRESETS, style)
      ? PRESETS[style]
      : PRESETS[DEFAULT_STYLE];
    var width = Number(opts.width);
    var height = Number(opts.height);
    var rawIndex = Number(opts.lineIndex);
    var lineIndex = Number.isFinite(rawIndex) ? Math.trunc(rawIndex) : 0;
    var seedValue;
    if (typeof opts.seed === "number" && Number.isFinite(opts.seed)) {
      seedValue = opts.seed >>> 0;
    } else {
      seedValue = hashText(opts.seed == null ? "" : String(opts.seed));
    }
    return {
      preset: preset,
      style: preset.id,
      width: Number.isFinite(width) && width > 0 ? width : 0,
      height: Number.isFinite(height) && height > 0 ? height : 0,
      seed: seedValue,
      lineIndex: lineIndex,
    };
  }

  /* ------------------------------------------------------------ path -- */
  function buildPoints(opts, random, overrides) {
    var preset = opts.preset;
    var width = opts.width;
    var height = opts.height;
    var extra = overrides || {};
    var count = Math.max(2, extra.points || preset.points);
    var amplitude = (extra.amplitude == null ? preset.amplitude : extra.amplitude) * height;
    /* The preset amplitude is read as the wave's peak deviation; the composite
       below only reaches about 70% of it on most lines, keeping the curve calm. */
    var peak = amplitude * 0.7;
    var baseY = height * preset.baseline;
    var minY = height * 0.85;
    /* The line may hang a hair below the band so it clears descenders; the
       reader draws with overflow visible. */
    var maxY = height * 1.035;
    var overshoot = (extra.overshoot == null ? preset.overshoot : extra.overshoot) * height;
    var yOffset = extra.yOffset || 0;

    /* Low-frequency drift made of one or two soft lobes. Alternating signs for
       4+ knots give the gentle S-curve a real hand leaves; 3 knots get a
       single, extremely shallow arc. Endpoints barely drift, so the stroke
       starts and ends with a clean pen-down rather than a hook. */
    var drift = [];
    var phase = random() < 0.5 ? -1 : 1;
    var alternate = count >= 4 && random() < 0.62;
    for (var i = 0; i < count; i += 1) {
      if (i === 0 || i === count - 1) {
        drift.push((random() * 2 - 1) * 0.16);
      } else if (alternate) {
        drift.push(phase * (i % 2 === 1 ? 1 : -1) * (0.55 + random() * 0.45));
      } else {
        drift.push(phase * (0.6 + random() * 0.4));
      }
    }
    var peakDrift = 0;
    for (var k = 0; k < count; k += 1) peakDrift = Math.max(peakDrift, Math.abs(drift[k]));
    if (peakDrift > 1e-6) {
      for (var m = 0; m < count; m += 1) drift[m] /= peakDrift;
    }

    var tiltSign = random() < 0.5 ? -1 : 1;
    var bowSign = random() < 0.5 ? -1 : 1;
    var tailSign = random() < 0.5 ? -1 : 1;
    /* A gentle overall tilt: at most a few px from the first to the last point,
       independent of line length and of the wave budget. */
    var tiltSpan = preset.tilt * height * tiltSign;
    var gap = 0.34 / (count - 1);
    var points = [];

    for (var index = 0; index < count; index += 1) {
      var t;
      if (index === 0) t = 0;
      else if (index === count - 1) t = 1;
      else {
        var base = index / (count - 1);
        t = base + (random() * 2 - 1) * gap * 0.5;
      }
      var bowValue = Math.sin(Math.PI * t) * bowSign;
      var tailValue = index === 0 ? -tailSign : index === count - 1 ? tailSign : 0;
      /* drift carries most of the wave; the bow and the end tails only add
         character. No high-frequency terms are used at all. */
      var composite = (0.62 * drift[index] + 0.22 * bowValue + 0.1 * tailValue) / 0.94;
      var y = baseY + peak * composite + tiltSpan * (t - 0.5) + yOffset;
      points.push({
        x: -overshoot + t * (width + overshoot * 2),
        y: clamp(y, minY + yOffset, maxY + yOffset),
      });
    }
    return points;
  }

  function reflect(anchor, other) {
    return { x: anchor.x * 2 - other.x, y: anchor.y * 2 - other.y };
  }

  /* Uniform Catmull-Rom through the knots, emitted as cubic Beziers. The
     tension factor keeps the curve from overshooting its control points. */
  function catmullRomPath(points, tension) {
    if (!points.length) return "";
    if (points.length === 1) {
      return "M " + round2(points[0].x) + " " + round2(points[0].y);
    }
    var last = points.length - 1;
    var d = "M " + round2(points[0].x) + " " + round2(points[0].y);
    for (var i = 0; i < last; i += 1) {
      var p0 = i > 0 ? points[i - 1] : reflect(points[0], points[1]);
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = i + 2 <= last ? points[i + 2] : reflect(points[last], points[last - 1]);
      var c1x = p1.x + ((p2.x - p0.x) * tension) / 6;
      var c1y = p1.y + ((p2.y - p0.y) * tension) / 6;
      var c2x = p2.x - ((p3.x - p1.x) * tension) / 6;
      var c2y = p2.y - ((p3.y - p1.y) * tension) / 6;
      d +=
        " C " + round2(c1x) + " " + round2(c1y) +
        " " + round2(c2x) + " " + round2(c2y) +
        " " + round2(p2.x) + " " + round2(p2.y);
    }
    return d;
  }

  function buildGeometry(options) {
    var opts = readOptions(options);
    var preset = opts.preset;
    var width = round2(opts.width);
    var height = round2(opts.height);
    var random = makeRandom(mixSeed(opts.seed, opts.lineIndex));
    /* Stroke widths grow sub-linearly with the band so a zoomed page keeps a
       believable pen weight instead of a fat marker. A tiny deterministic
       width jitter gives each annotation its own pen. */
    var strokeScale = clamp(Math.sqrt(height / BASE_HEIGHT), 0.82, 1.85);
    var penJitter = 0.96 + random() * 0.08;
    var strokeWidth = round2(preset.stroke * strokeScale * penJitter);
    var geometry = {
      style: opts.style,
      preset: preset,
      width: opts.width,
      height: opts.height,
      seed: opts.seed,
      lineIndex: opts.lineIndex,
      strokeWidth: strokeWidth,
      ghostWidth: round2(strokeWidth * 0.58),
      opacity: preset.opacity,
      ghostOpacity: round2(preset.opacity * preset.ghost),
      points: [],
      d: "",
      ghostD: "",
    };

    if (opts.width < MIN_DRAWABLE_WIDTH || opts.height < MIN_DRAWABLE_HEIGHT) {
      var y = round2(height * preset.baseline);
      geometry.d = "M 0 " + y + " L " + width + " " + y;
      return geometry;
    }

    var points = buildPoints(opts, random);
    geometry.points = points.map(function (point) {
      return { x: round2(point.x), y: round2(point.y) };
    });
    geometry.d = catmullRomPath(points, preset.tension);

    /* A faint second pass sits a hair lower: it hints at pen pressure without
       doubling the visible thickness. */
    var ghostRandom = makeRandom(mixSeed(opts.seed ^ 0x85ebca6b, opts.lineIndex));
    var ghostPoints = buildPoints(opts, ghostRandom, {
      points: Math.min(3, preset.points),
      amplitude: preset.amplitude * 0.62,
      overshoot: preset.overshoot * 0.45,
      yOffset: strokeWidth * 0.38,
    });
    geometry.ghostD = catmullRomPath(ghostPoints, preset.tension * 0.82);
    return geometry;
  }

  function pathData(options) {
    return buildGeometry(options).d;
  }

  function describe(options) {
    var geometry = buildGeometry(options);
    var preset = geometry.preset;
    return {
      style: geometry.style,
      preset: preset,
      width: geometry.width,
      height: geometry.height,
      seed: geometry.seed,
      lineIndex: geometry.lineIndex,
      strokeWidth: geometry.strokeWidth,
      ghostWidth: geometry.ghostWidth,
      opacity: geometry.opacity,
      ghostOpacity: geometry.ghostOpacity,
      points: geometry.points,
      d: geometry.d,
      ghostD: geometry.ghostD,
    };
  }

  /* ---------------------------------------------------------- render -- */
  function makeSvgChild(tag) {
    return global.document.createElementNS(SVG_NS, tag);
  }

  /* The reader paints each mark with an inline --mark-color custom property;
     picking it up here means an integrator only has to append the SVG. */
  function resolveColor(svg, options) {
    if (options && options.color != null) return String(options.color);
    if (global.getComputedStyle) {
      try {
        var inherited = global.getComputedStyle(svg).getPropertyValue("--mark-color").trim();
        if (inherited) return inherited;
      } catch (error) {
        /* detached SVG or a very old engine: fall through to currentColor */
      }
    }
    return "currentColor";
  }

  function render(svg, options) {
    if (!svg || typeof svg.appendChild !== "function") return null;
    var geometry = buildGeometry(options);
    var color = resolveColor(svg, options);
    var width = round2(geometry.width);
    var height = round2(geometry.height);

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    /* Tails overshoot the text box by design; keep them visible and never let
       the decoration catch pointer events meant for the text layer. */
    svg.style.overflow = "visible";
    svg.style.pointerEvents = "none";
    if (!svg.style.display) svg.style.display = "block";

    var group = makeSvgChild("g");
    group.setAttribute("fill", "none");
    group.setAttribute("stroke", color);
    group.setAttribute("stroke-linecap", "round");
    group.setAttribute("stroke-linejoin", "round");

    if (geometry.ghostD) {
      var ghost = makeSvgChild("path");
      ghost.setAttribute("d", geometry.ghostD);
      ghost.setAttribute("stroke-width", String(geometry.ghostWidth));
      ghost.setAttribute("opacity", String(geometry.ghostOpacity));
      ghost.setAttribute("class", "hand-underline-ghost");
      group.appendChild(ghost);
    }

    var main = makeSvgChild("path");
    main.setAttribute("d", geometry.d);
    main.setAttribute("stroke-width", String(geometry.strokeWidth));
    main.setAttribute("opacity", String(geometry.opacity));
    main.setAttribute("class", "hand-underline-ink");
    group.appendChild(main);
    svg.appendChild(group);
    return main;
  }

  /* ---------------------------------------------------------- presets -- */
  var PRESETS = {};
  for (var p = 0; p < ORDER.length; p += 1) {
    var id = ORDER[p];
    PRESETS[id] = Object.freeze(PRESET_DEFS[id]);
  }
  /* Short handles (PRESETS.soft ...) for callers that prefer names over ids;
     non-enumerable so PRESETS still iterates as an id map. */
  Object.defineProperties(PRESETS, {
    soft: { value: PRESETS["hand-soft"], enumerable: false },
    natural: { value: PRESETS["hand-natural"], enumerable: false },
    strong: { value: PRESETS["hand-strong"], enumerable: false },
  });
  Object.freeze(PRESETS);

  var api = Object.freeze({
    PRESETS: PRESETS,
    ORDER: Object.freeze(ORDER.slice()),
    DEFAULT_STYLE: DEFAULT_STYLE,
    isHandStyle: isHandStyle,
    normalizeStyle: normalizeStyle,
    pathData: pathData,
    describe: describe,
    render: render,
  });

  global.StudioHandUnderline = api;
})(typeof window !== "undefined" ? window : globalThis);

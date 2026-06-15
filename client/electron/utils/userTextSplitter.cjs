const DEFAULT_CONTEXT_LENGTH_LIMIT = 400000;
const DEFAULT_CONTEXT_LIMIT_RATIO = 0.8;
const STRICT_WINDOW_RATIO = 0.12;
const RELAXED_WINDOW_RATIO = 0.25;
const MIN_SEGMENT_RATIO = 0.35;
const MAX_SEGMENT_LIMIT_RATIO = 1.1;

const BOUNDARY_GROUPS = [
  [/\r?\n(?=\s{0,3}#{1,6}\s+)/g, /\r?\n[ \t]*\r?\n/g],
  [/\r?\n/g],
  [/[。！？!?]/g],
  [/[；;]/g],
  [/[，,、：:]/g],
];

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizePositiveRatio(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function normalizeContextLengthLimit(config, options) {
  const source = options.contextLengthLimit !== undefined
    ? options.contextLengthLimit
    : config?.context_length_limit;
  return normalizePositiveInteger(source, DEFAULT_CONTEXT_LENGTH_LIMIT);
}

function collectMarkdownFenceRanges(text) {
  const ranges = [];
  const regex = /(^|\n)(```|~~~)/g;
  let openedAt = -1;
  let openedMarker = '';
  let match = regex.exec(text);

  while (match) {
    const markerStart = match.index + match[1].length;
    const marker = match[2];

    if (openedAt < 0) {
      openedAt = markerStart;
      openedMarker = marker;
    } else if (marker === openedMarker) {
      ranges.push([openedAt, markerStart + marker.length]);
      openedAt = -1;
      openedMarker = '';
    }

    match = regex.exec(text);
  }

  if (openedAt >= 0) {
    ranges.push([openedAt, text.length]);
  }

  return ranges;
}

function isInsideRange(index, ranges) {
  for (const [start, end] of ranges) {
    if (index <= start) return false;
    if (index < end) return true;
  }
  return false;
}

function avoidsBreakingSurrogatePair(text, cut) {
  if (cut <= 0 || cut >= text.length) {
    return cut;
  }

  const previous = text.charCodeAt(cut - 1);
  const next = text.charCodeAt(cut);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return cut + 1;
  }
  return cut;
}

function clampHardCut(text, idealCut, previousCut, remainingSegments) {
  const minimumCut = previousCut + 1;
  const maximumCut = text.length - remainingSegments;
  if (maximumCut < minimumCut) {
    return Math.min(text.length, minimumCut);
  }
  const clamped = Math.min(maximumCut, Math.max(minimumCut, Math.round(idealCut)));
  return avoidsBreakingSurrogatePair(text, clamped);
}

function canUseCandidate(candidate, state) {
  if (candidate <= state.previousCut || candidate >= state.totalLength) {
    return false;
  }

  const currentLength = candidate - state.previousCut;
  if (currentLength < state.minimumSegmentLength) {
    return false;
  }

  if (currentLength > state.maximumSegmentLength) {
    return false;
  }

  if (state.remainingSegments > 0) {
    const remainingLength = state.totalLength - candidate;
    if (remainingLength < state.remainingSegments) {
      return false;
    }
    if (remainingLength / state.remainingSegments > state.maximumSegmentLength) {
      return false;
    }
  }

  return true;
}

function findBoundaryForGroup(text, from, to, group, state, fenceRanges) {
  let best = null;
  const content = text.slice(from, to);

  for (const pattern of group) {
    pattern.lastIndex = 0;
    let match = pattern.exec(content);
    while (match) {
      const candidate = from + match.index + match[0].length;
      if (!isInsideRange(candidate, fenceRanges) && canUseCandidate(candidate, state)) {
        const score = Math.abs(candidate - state.idealCut);
        if (!best || score < best.score) {
          best = { cut: candidate, score };
        }
      }

      if (!match[0]) {
        pattern.lastIndex += 1;
      }
      match = pattern.exec(content);
    }
  }

  return best?.cut || 0;
}

function findNaturalCut(text, idealCut, previousCut, state, fenceRanges, radius) {
  const from = Math.max(previousCut + 1, Math.floor(idealCut - radius));
  const to = Math.min(text.length - state.remainingSegments, Math.ceil(idealCut + radius));
  if (to <= from) {
    return 0;
  }

  for (const group of BOUNDARY_GROUPS) {
    const cut = findBoundaryForGroup(text, from, to, group, state, fenceRanges);
    if (cut) {
      return cut;
    }
  }

  return 0;
}

function splitUserTextByContextLimit(text, config = {}, options = {}) {
  const source = String(text ?? '');
  const contextLengthLimit = normalizeContextLengthLimit(config, options);
  const limitRatio = normalizePositiveRatio(options.limitRatio, DEFAULT_CONTEXT_LIMIT_RATIO);
  const segmentLimit = Math.max(1, Math.floor(contextLengthLimit * limitRatio));

  if (source.length <= segmentLimit) {
    return [source];
  }

  const segmentCount = Math.ceil(source.length / segmentLimit);
  const targetSize = Math.max(1, Math.ceil(source.length / segmentCount));
  const strictRadius = Math.max(1, Math.floor(targetSize * normalizePositiveRatio(options.strictWindowRatio, STRICT_WINDOW_RATIO)));
  const relaxedRadius = Math.max(strictRadius, Math.floor(targetSize * normalizePositiveRatio(options.relaxedWindowRatio, RELAXED_WINDOW_RATIO)));
  const maximumSegmentLength = Math.max(targetSize, Math.ceil(segmentLimit * normalizePositiveRatio(options.maxSegmentLimitRatio, MAX_SEGMENT_LIMIT_RATIO)));
  const minimumSegmentLength = Math.max(1, Math.floor(targetSize * normalizePositiveRatio(options.minSegmentRatio, MIN_SEGMENT_RATIO)));
  const fenceRanges = collectMarkdownFenceRanges(source);
  const cuts = [];
  let previousCut = 0;

  for (let segmentIndex = 1; segmentIndex < segmentCount; segmentIndex += 1) {
    const idealCut = (source.length * segmentIndex) / segmentCount;
    const remainingSegments = segmentCount - segmentIndex;
    const state = {
      idealCut,
      previousCut,
      totalLength: source.length,
      remainingSegments,
      minimumSegmentLength,
      maximumSegmentLength,
    };
    const naturalCut = findNaturalCut(source, idealCut, previousCut, state, fenceRanges, strictRadius)
      || findNaturalCut(source, idealCut, previousCut, state, fenceRanges, relaxedRadius);
    const cut = naturalCut || clampHardCut(source, idealCut, previousCut, remainingSegments);
    cuts.push(cut);
    previousCut = cut;
  }

  const parts = [];
  let start = 0;
  for (const cut of cuts) {
    parts.push(source.slice(start, cut));
    start = cut;
  }
  parts.push(source.slice(start));

  return parts;
}

module.exports = {
  splitUserTextByContextLimit,
};

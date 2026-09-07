/** Drop one min and one max, then average the rest. Used for n-repeat live timings. */

export function numericTrimmedMean(values: number[]): {
  mean: number;
  kept: number[];
  dropped: number[];
} {
  if (values.length === 0) return { mean: Number.NaN, kept: [], dropped: [] };
  if (values.length < 3) {
    return { mean: meanOf(values), kept: [...values], dropped: [] };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const dropped = [sorted[0]!, sorted[sorted.length - 1]!];
  const kept = sorted.slice(1, -1);
  return { mean: meanOf(kept), kept, dropped };
}

export function meanOf(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface RepeatSample {
  status: "pass" | "fail" | "catalog_missing";
  duration_ms?: number;
  first_byte_ms?: number;
  first_tool_ms?: number;
  tool_count?: number;
  rounds?: number;
  report_chars?: number;
}

export interface TrimmedTiming {
  n: number;
  passed: number;
  kept: number;
  duration_ms?: number;
  first_byte_ms?: number;
  first_tool_ms?: number;
  tool_count?: number;
  rounds?: number;
  report_chars?: number;
  duration_dropped?: number[];
  first_byte_dropped?: number[];
}

const FIELDS = [
  "duration_ms",
  "first_byte_ms",
  "first_tool_ms",
  "tool_count",
  "rounds",
  "report_chars",
] as const;

export function trimmedTiming(samples: RepeatSample[]): TrimmedTiming {
  const passed = samples.filter((sample) => sample.status === "pass");
  const summary: TrimmedTiming = {
    n: samples.length,
    passed: passed.length,
    kept: passed.length < 3 ? passed.length : Math.max(0, passed.length - 2),
  };
  for (const field of FIELDS) {
    const values = passed
      .map((sample) => sample[field])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) continue;
    const trim = numericTrimmedMean(values);
    if (Number.isFinite(trim.mean)) summary[field] = trim.mean;
    if (field === "duration_ms") summary.duration_dropped = trim.dropped;
    if (field === "first_byte_ms") summary.first_byte_dropped = trim.dropped;
  }
  return summary;
}

export function sampleReceipt(sample: RepeatSample): RepeatSample {
  return {
    status: sample.status,
    duration_ms: sample.duration_ms,
    first_byte_ms: sample.first_byte_ms,
    first_tool_ms: sample.first_tool_ms,
    tool_count: sample.tool_count,
    rounds: sample.rounds,
    report_chars: sample.report_chars,
  };
}

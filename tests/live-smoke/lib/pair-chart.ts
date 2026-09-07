/** Same-work pair chart: orange = gateway protocol, black = raw Cursor CLI. */

export interface PairChartSide {
  first_byte_s: number;
  duration_s: number;
}

export interface PairChartRow {
  label: string;
  protocol: string;
  fast: string;
  gateway: PairChartSide;
  cli: PairChartSide;
}

export interface PairChartInput {
  title: string;
  subtitle: string;
  callout: string;
  footer: string[];
  firstByteCaption: string;
  durationCaption: string;
  pairs: PairChartRow[];
}

const WIDTH = 1080;
const HEIGHT = 920;
const LEFT = 80;
const RIGHT = 1044;
const BAR = 34;
const GAP = 10;

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const padded = value * 1.06;
  const pow = 10 ** Math.floor(Math.log10(padded));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 4, 5, 8, 10]) {
    if (padded <= step * pow) return step * pow;
  }
  return 10 * pow;
}

function ticks(max: number): number[] {
  const count = 5;
  return Array.from({ length: count + 1 }, (_, i) => (max * i) / count);
}

function formatTick(value: number): string {
  if (value === 0) return "0";
  if (value >= 10 && Number.isInteger(value)) return `${value}s`;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

function formatBar(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function yAt(value: number, top: number, bottom: number, max: number): number {
  return bottom - (value / max) * (bottom - top);
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderPairChart(input: PairChartInput): string {
  const firstMax = niceMax(Math.max(0, ...input.pairs.flatMap((row) => [row.gateway.first_byte_s, row.cli.first_byte_s])));
  const durationMax = niceMax(Math.max(0, ...input.pairs.flatMap((row) => [row.gateway.duration_s, row.cli.duration_s])));
  const columns = input.pairs.map((row, index) => {
    const center = LEFT + ((RIGHT - LEFT) / input.pairs.length) * (index + 0.5);
    return { row, center };
  });

  const firstPlot = { top: 166, bottom: 366, labelY: 140 };
  const durationPlot = { top: 482, bottom: 682, labelY: 456 };

  const firstBars = renderPlot(columns, firstPlot, firstMax, "first_byte_s");
  const durationBars = renderPlot(columns, durationPlot, durationMax, "duration_s");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-labelledby="title desc">
  <title id="title">${escapeXml(input.title)}</title>
  <desc id="desc">${escapeXml(input.subtitle)}</desc>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#fffdfb"/>
  <rect x="0" y="0" width="8" height="${HEIGHT}" fill="#ff6a33"/>
  <text x="36" y="32" fill="#111417" font-size="22" font-weight="750" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(input.title)}</text>
  <text x="36" y="54" fill="#6b6560" font-size="13" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(input.subtitle)}</text>
  <g font-family="ui-sans-serif, system-ui, sans-serif">
    <rect x="36" y="68" width="14" height="14" rx="3" fill="#ff6a33"/>
    <text x="56" y="80" fill="#111417" font-size="13">Proxy API (Claude Code / Codex / Grok Build protocol)</text>
    <rect x="500" y="68" width="14" height="14" rx="3" fill="#111417"/>
    <text x="520" y="80" fill="#111417" font-size="13">Raw Cursor CLI</text>
    <rect x="36" y="90" width="1008" height="22" rx="6" fill="#fff4ee"/>
    <text x="48" y="106" fill="#6b6560" font-size="12">${escapeXml(input.callout)}</text>
    <text x="80" y="${firstPlot.labelY}" fill="#111417" font-size="16" font-weight="700">${escapeXml(input.firstByteCaption)}</text>
${firstBars}
    <text x="80" y="${durationPlot.labelY}" fill="#111417" font-size="16" font-weight="700">${escapeXml(input.durationCaption)}</text>
${durationBars}
  </g>
  <text x="36" y="892" fill="#6b6560" font-size="11.5" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(input.footer[0] ?? "")}</text>
  <text x="36" y="908" fill="#6b6560" font-size="11.5" font-family="ui-sans-serif, system-ui, sans-serif">${escapeXml(input.footer[1] ?? "")}</text>
</svg>
`;
}

function renderPlot(
  columns: Array<{ row: PairChartRow; center: number }>,
  plot: { top: number; bottom: number },
  max: number,
  field: "first_byte_s" | "duration_s",
): string {
  const grid = ticks(max).map((value) => {
    const y = yAt(value, plot.top, plot.bottom, max);
    return `<line x1="${LEFT}" y1="${y.toFixed(1)}" x2="${RIGHT}" y2="${y.toFixed(1)}" stroke="#ece7e2"/>
<text x="70" y="${(y + 4).toFixed(1)}" fill="#6b6560" font-size="11" text-anchor="end">${formatTick(value)}</text>`;
  }).join("\n");
  const axis = `<line x1="${LEFT}" y1="${plot.bottom}" x2="${RIGHT}" y2="${plot.bottom}" stroke="#111417" stroke-width="1.25"/>`;
  const bars = columns.map(({ row, center }) => {
    const gw = row.gateway[field];
    const cli = row.cli[field];
    const gwX = center - BAR - GAP / 2;
    const cliX = center + GAP / 2;
    const gwY = yAt(gw, plot.top, plot.bottom, max);
    const cliY = yAt(cli, plot.top, plot.bottom, max);
    return `<rect x="${gwX.toFixed(1)}" y="${gwY.toFixed(1)}" width="${BAR}" height="${(plot.bottom - gwY).toFixed(1)}" rx="4" fill="#ff6a33"/>
<rect x="${cliX.toFixed(1)}" y="${cliY.toFixed(1)}" width="${BAR}" height="${(plot.bottom - cliY).toFixed(1)}" rx="4" fill="#111417"/>
<text x="${(gwX + BAR / 2).toFixed(1)}" y="${(gwY - 7).toFixed(1)}" fill="#ff6a33" font-size="12" font-weight="700" text-anchor="middle">${formatBar(gw)}</text>
<text x="${(cliX + BAR / 2).toFixed(1)}" y="${(cliY - 7).toFixed(1)}" fill="#111417" font-size="12" font-weight="700" text-anchor="middle">${formatBar(cli)}</text>
<text x="${center.toFixed(1)}" y="${plot.bottom + 20}" fill="#111417" font-size="13" font-weight="700" text-anchor="middle">${escapeXml(row.label)}</text>
<text x="${center.toFixed(1)}" y="${plot.bottom + 36}" fill="#6b6560" font-size="11" text-anchor="middle">${escapeXml(row.protocol)}</text>
<text x="${center.toFixed(1)}" y="${plot.bottom + 52}" fill="#6b6560" font-size="11" text-anchor="middle">${escapeXml(row.fast)}</text>`;
  }).join("\n");
  return `${grid}\n${axis}\n${bars}`;
}

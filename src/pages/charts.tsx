import { raw } from "hono/html";
import type { Stats } from "../types.ts";
import { compact, full, shortDay } from "./format.ts";

type Point = Stats["series"][number];

const W = 720;
const H = 180;
const TOP = 6;
const BOTTOM = 179;

const INK = "#171717";
const MUTED = "#8f8f8f";
const RULE = "#ebebeb";
const WELL = "#e7e7e7";

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function r1(n: number): string {
	return Math.round(n).toString();
}

/**
 * Daily users as a thin ink line over very light event bars on a secondary scale.
 * Responsive via viewBox; server-rendered; one path for all bars to keep the HTML small.
 */
export function usageChartSvg(series: Point[]): string {
	const n = series.length;
	const maxU = Math.max(0, ...series.map((p) => p.dau));
	const maxE = Math.max(0, ...series.map((p) => p.events));
	const totalE = series.reduce((a, p) => a + p.events, 0);
	const first = series[0]?.day;
	const last = series[n - 1]?.day;
	const peak = series.reduce<Point | undefined>((a, p) => (a === undefined || p.dau > a.dau ? p : a), undefined);

	const label =
		n === 0 || (maxU === 0 && maxE === 0)
			? "Daily users and events: no data in this range."
			: `Daily users and events, ${shortDay(first!)} to ${shortDay(last!)}. Peak ${full(maxU)} users on ${shortDay(peak!.day)}; ${full(totalE)} events in total.`;

	const slot = n > 1 ? W / (n - 1) : W / 4;
	const barW = Math.max(1, Math.min(slot * 0.6, 28));
	const pad = barW / 2;
	const x = (i: number) => (n <= 1 ? W / 2 : pad + (i / (n - 1)) * (W - barW));
	const yU = (v: number) => (maxU ? BOTTOM - (v / maxU) * (BOTTOM - TOP) : BOTTOM);
	const yE = (v: number) => (maxE ? BOTTOM - (v / maxE) * (BOTTOM - TOP) : BOTTOM);

	let bars = "";
	const pts: string[] = [];
	for (let i = 0; i < n; i++) {
		const p = series[i]!;
		if (p.events > 0) {
			bars += `M${r1(x(i) - pad)} ${r1(yE(p.events))}h${r1(barW)}V${BOTTOM}h-${r1(barW)}Z`;
		}
		pts.push(`${r1(x(i))},${r1(yU(p.dau))}`);
	}

	const parts: string[] = [];
	parts.push(`<line x1="0" y1="${BOTTOM}" x2="${W}" y2="${BOTTOM}" stroke="${RULE}"/>`);
	if (bars) parts.push(`<path d="${bars}" fill="${WELL}"/>`);
	if (n === 1) {
		parts.push(`<circle cx="${r1(x(0))}" cy="${r1(yU(series[0]!.dau))}" r="3" fill="${INK}"/>`);
	} else if (n > 1) {
		parts.push(
			`<polyline points="${pts.join(" ")}" fill="none" stroke="${INK}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`,
		);
	}
	if (n === 0 || (maxU === 0 && maxE === 0)) {
		parts.push(`<text x="${W / 2}" y="${(TOP + BOTTOM) / 2}" text-anchor="middle" fill="${MUTED}" font-size="14">No data in this range</text>`);
	}

	return (
		`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">` +
		`<title>${esc(label)}</title>` +
		parts.join("") +
		`</svg>`
	);
}

/** The chart with its scale and date labels as HTML, so they stay readable when the SVG scales down on a phone. */
export function UsageChart({ series }: { series: Point[] }) {
	const n = series.length;
	const maxU = Math.max(0, ...series.map((p) => p.dau));
	const maxE = Math.max(0, ...series.map((p) => p.events));
	const hasData = n > 0 && (maxU > 0 || maxE > 0);
	return (
		<div class="chart-wrap">
			{hasData && (
				<div class="chart-axis">
					<span>{compact(maxU)} users</span>
					<span class="muted">{compact(maxE)} events</span>
				</div>
			)}
			{raw(usageChartSvg(series))}
			{n > 0 && (
				<div class="chart-axis muted">
					<span>{shortDay(series[0]!.day)}</span>
					{n > 1 && <span>{shortDay(series[n - 1]!.day)}</span>}
				</div>
			)}
		</div>
	);
}

const SW = 120;
const SH = 30;

/**
 * Tiny daily-users line for registry tiles and rows: one thin ink polyline on the ground colour,
 * a baseline in the rule colour, no axes. Decorative; the number next to it carries the meaning.
 */
export function sparklineSvg(series: number[]): string {
	const n = series.length;
	const max = Math.max(0, ...series);
	const top = 4;
	const bottom = SH - 3;
	const x = (i: number) => (n <= 1 ? SW / 2 : (i / (n - 1)) * SW);
	const y = (v: number) => (max ? bottom - (v / max) * (bottom - top) : bottom);
	const parts: string[] = [`<line x1="0" y1="${bottom}" x2="${SW}" y2="${bottom}" stroke="${RULE}"/>`];
	if (n === 1) {
		parts.push(`<circle cx="${SW / 2}" cy="${y(series[0]!).toFixed(1)}" r="2" fill="${INK}"/>`);
	} else if (n > 1) {
		const pts = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
		parts.push(
			`<polyline points="${pts}" fill="none" stroke="${INK}" stroke-width="1.1" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`,
		);
	}
	return `<svg viewBox="0 0 ${SW} ${SH}" aria-hidden="true" focusable="false">${parts.join("")}</svg>`;
}

export function Sparkline({ series }: { series: number[] }) {
	return raw(sparklineSvg(series));
}

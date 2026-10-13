import { raw } from "hono/html";
import type { Stats } from "../types.ts";
import { compact, full, shortDay } from "./format.ts";

type Point = Stats["series"][number];

const W = 720;
const H = 224;
const TOP = 28;
const BOTTOM = 196;

function esc(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function r1(n: number): string {
	return Math.round(n).toString();
}

/**
 * Daily users as a thin accent line over light event bars on a secondary scale.
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
	parts.push(`<line x1="0" y1="${BOTTOM}" x2="${W}" y2="${BOTTOM}" stroke="#eaeaea"/>`);
	if (bars) parts.push(`<path d="${bars}" fill="#dbe4f5"/>`);
	if (n === 1) {
		parts.push(`<circle cx="${r1(x(0))}" cy="${r1(yU(series[0]!.dau))}" r="3.5" fill="#2563eb"/>`);
	} else if (n > 1) {
		parts.push(
			`<polyline points="${pts.join(" ")}" fill="none" stroke="#2563eb" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`,
		);
	}
	if (n === 0 || (maxU === 0 && maxE === 0)) {
		parts.push(`<text x="${W / 2}" y="${(TOP + BOTTOM) / 2}" text-anchor="middle" fill="#6b7280" font-size="13">No data in this range</text>`);
	} else {
		parts.push(`<text x="0" y="16" fill="#2563eb" font-size="12">${compact(maxU)} users</text>`);
		parts.push(`<text x="${W}" y="16" text-anchor="end" fill="#6b7280" font-size="12">${compact(maxE)} events</text>`);
	}
	if (first) parts.push(`<text x="0" y="${H - 6}" fill="#6b7280" font-size="12">${esc(shortDay(first))}</text>`);
	if (last && n > 1) parts.push(`<text x="${W}" y="${H - 6}" text-anchor="end" fill="#6b7280" font-size="12">${esc(shortDay(last))}</text>`);

	return (
		`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">` +
		`<title>${esc(label)}</title>` +
		parts.join("") +
		`</svg>`
	);
}

export function UsageChart({ series }: { series: Point[] }) {
	return raw(usageChartSvg(series));
}

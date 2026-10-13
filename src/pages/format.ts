/** 1234 → "1.2k", 1234567 → "1.2M". Whole numbers below 1000 stay as-is. */
export function compact(n: number): string {
	if (!Number.isFinite(n)) return "0";
	const abs = Math.abs(n);
	if (abs < 1000) return String(Math.round(n));
	const units = [
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "k"],
	] as const;
	for (const [div, unit] of units) {
		if (abs >= div) {
			const v = n / div;
			return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "")) + unit;
		}
	}
	return String(n);
}

export function full(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

/** "2026-01-05" or ISO timestamp → "Jan 5, 2026". */
export function fmtDate(iso: string): string {
	const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "2026-01-05" → "Jan 5". */
export function shortDay(day: string): string {
	const d = new Date(`${day}T00:00:00Z`);
	if (Number.isNaN(d.getTime())) return day;
	return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

export function pct(part: number, whole: number): number {
	if (!whole) return 0;
	return Math.max(0, Math.min(100, Math.round((part / whole) * 1000) / 10));
}

/** Dim name → section title. */
export function dimLabel(dim: string): string {
	const known: Record<string, string> = {
		event: "Events",
		version: "Versions",
		os: "Operating systems",
		arch: "Architectures",
		country: "Countries",
		ci: "CI",
		source: "Sources",
	};
	if (known[dim]) return known[dim];
	if (dim.startsWith("prop:")) return `prop · ${dim.slice(5)}`;
	return dim;
}

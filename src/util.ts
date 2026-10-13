export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** Top-level paths that can never be project slugs. */
export const RESERVED = new Set([
	"api",
	"v1",
	"health",
	"assets",
	"static",
	"docs",
	"sdk",
	"admin",
	"llms.txt",
	"agents.md",
	"install.md",
	"favicon.ico",
	"robots.txt",
	"new",
	"login",
	"fonts",
	"_headers",
]);

export function isValidSlug(slug: string): boolean {
	return SLUG_RE.test(slug) && !RESERVED.has(slug);
}

export async function sha256hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** UTC day, YYYY-MM-DD. */
export function utcDay(d: Date = new Date()): string {
	return d.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
	const d = new Date(`${day}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + delta);
	return utcDay(d);
}

export function baseUrl(req: Request): string {
	return new URL(req.url).origin;
}

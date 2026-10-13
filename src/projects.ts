import { getSalt, rememberProject } from "./db.ts";
import { addToDims, runRollup, topDims, upsertDaily } from "./rollup.ts";
import type { Ctx, DailyRow, Dims, Project } from "./types.ts";
import { addDays, baseUrl, isValidSlug, randomHex, sha256hex, utcDay } from "./util.ts";

const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_HOMEPAGE = 200;
const MAX_CREATES_PER_DAY = 5;
const MAX_IMPORT_ROWS = 360;
const MAX_DIMS_JSON = 16 * 1024;
/** Analytics Engine keeps raw events for 90 days, so a rollup can only be rebuilt within this window. */
const ROLLUP_WINDOW_DAYS = 89;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

class BadRequest extends Error {}

/** A YYYY-MM-DD that exists on the calendar; new Date() rolls 02-30 over and throws on 13-40. */
function isRealDay(day: unknown): day is string {
	if (typeof day !== "string" || !DAY_RE.test(day)) return false;
	try {
		return addDays(day, 0) === day;
	} catch {
		return false;
	}
}

export async function queryProjects(db: D1Database): Promise<Project[]> {
	const { results } = await db
		.prepare("SELECT slug, name, description, homepage, created_at FROM projects ORDER BY created_at DESC")
		.all<Project>();
	return results;
}

export async function listProjects(c: Ctx): Promise<Response> {
	return c.json({ projects: await queryProjects(c.env.DB) });
}

function optionalText(v: unknown, field: string, max: number): string | null {
	if (v === undefined || v === null || v === "") return null;
	if (typeof v !== "string" || v.length > max) throw new BadRequest(`${field} must be a string of at most ${max} chars`);
	return v.trim() || null;
}

function homepageUrl(v: unknown): string | null {
	const s = optionalText(v, "homepage", MAX_HOMEPAGE);
	if (s === null) return null;
	let protocol: string;
	try {
		protocol = new URL(s).protocol;
	} catch {
		throw new BadRequest("homepage must be an http(s) URL");
	}
	if (protocol !== "http:" && protocol !== "https:") throw new BadRequest("homepage must be an http(s) URL");
	return s;
}

async function readObject(c: Ctx): Promise<Record<string, unknown>> {
	const body = await c.req.json().catch(() => null);
	if (!body || typeof body !== "object" || Array.isArray(body)) throw new BadRequest("body must be a JSON object");
	return body as Record<string, unknown>;
}

export async function createProject(c: Ctx): Promise<Response> {
	let slug: string;
	let name: string | null;
	let description: string | null;
	let homepage: string | null;
	try {
		const body = await readObject(c);
		if (typeof body.slug !== "string" || !isValidSlug(body.slug)) {
			throw new BadRequest("slug must match ^[a-z0-9][a-z0-9-]{1,38}$ and not be reserved");
		}
		slug = body.slug;
		name = optionalText(body.name, "name", MAX_NAME);
		description = optionalText(body.description, "description", MAX_DESCRIPTION);
		homepage = homepageUrl(body.homepage);
	} catch (err) {
		if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
		throw err;
	}

	const day = utcDay();
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	const creator = (await sha256hex(`${getSalt()}|${day}|${ip}`)).slice(0, 16);
	const recent = await c.env.DB.prepare("SELECT count(*) AS n FROM projects WHERE creator = ? AND substr(created_at, 1, 10) = ?")
		.bind(creator, day)
		.first<{ n: number }>();
	if ((recent?.n ?? 0) >= MAX_CREATES_PER_DAY) {
		return c.json({ error: `at most ${MAX_CREATES_PER_DAY} projects can be created per day` }, 429);
	}

	const token = `tk_${randomHex(24)}`;
	try {
		await c.env.DB.prepare(
			"INSERT INTO projects (slug, name, description, homepage, admin_hash, created_at, creator) VALUES (?, ?, ?, ?, ?, ?, ?)",
		)
			.bind(slug, name, description, homepage, await sha256hex(token), new Date().toISOString(), creator)
			.run();
	} catch (err) {
		if (/UNIQUE|constraint/i.test(String(err instanceof Error ? err.message : err))) {
			return c.json({ error: "slug already exists" }, 409);
		}
		throw err;
	}
	rememberProject(slug, true);

	const base = baseUrl(c.req.raw);
	c.header("cache-control", "no-store");
	return c.json(
		{
			slug,
			admin_token: token,
			page_url: `${base}/${slug}`,
			ingest_url: `${base}/${slug}`,
			otlp_endpoint: `${base}/${slug}`,
			install_md: `${base}/${slug}/install.md`,
			stats_url: `${base}/api/${slug}/stats`,
		},
		201,
	);
}

function sameHash(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Returns an error response, or null when the bearer token belongs to `slug`. */
async function requireAdmin(c: Ctx, slug: string): Promise<Response | null> {
	if (!isValidSlug(slug)) return c.json({ error: "project not found" }, 404);
	const row = await c.env.DB.prepare("SELECT admin_hash FROM projects WHERE slug = ?")
		.bind(slug)
		.first<{ admin_hash: string }>();
	if (!row) return c.json({ error: "project not found" }, 404);
	const token = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "")?.[1];
	if (!token || !sameHash(await sha256hex(token), row.admin_hash)) {
		return c.json({ error: "missing or invalid admin token" }, 401);
	}
	return null;
}

export async function deleteProject(c: Ctx, slug: string): Promise<Response> {
	const denied = await requireAdmin(c, slug);
	if (denied) return denied;
	await c.env.DB.batch([
		c.env.DB.prepare("DELETE FROM daily WHERE project = ?").bind(slug),
		c.env.DB.prepare("DELETE FROM projects WHERE slug = ?").bind(slug),
	]);
	rememberProject(slug, false);
	return c.json({ deleted: true, note: "raw events in Analytics Engine expire after 90 days" });
}

function count(v: unknown, field: string): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
		throw new BadRequest(`${field} must be a non-negative integer`);
	}
	return v;
}

function parseDims(v: unknown): Dims {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest("dims must be an object");
	if (JSON.stringify(v).length > MAX_DIMS_JSON) throw new BadRequest("dims must be at most 16KB of JSON");
	const dims: Dims = {};
	for (const [dim, values] of Object.entries(v)) {
		if (!values || typeof values !== "object" || Array.isArray(values)) throw new BadRequest(`dims.${dim} must be an object`);
		for (const [value, pair] of Object.entries(values)) {
			if (!Array.isArray(pair) || pair.length !== 2) throw new BadRequest(`dims.${dim}.${value} must be [users, events]`);
			addToDims(dims, dim, value, count(pair[0], `dims.${dim}.${value}[0]`), count(pair[1], `dims.${dim}.${value}[1]`));
		}
	}
	return topDims(dims);
}

function parseRow(v: unknown, i: number, today: string): Omit<DailyRow, "source" | "project"> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequest(`rows[${i}] must be an object`);
	const r = v as Record<string, unknown>;
	const day = r.day;
	if (!isRealDay(day)) throw new BadRequest(`rows[${i}].day must be YYYY-MM-DD`);
	if (day > today) throw new BadRequest(`rows[${i}].day is in the future`);
	return {
		day,
		dau: count(r.dau, `rows[${i}].dau`),
		wau: count(r.wau, `rows[${i}].wau`),
		mau: count(r.mau, `rows[${i}].mau`),
		events: count(r.events, `rows[${i}].events`),
		dims: parseDims(r.dims),
	};
}

export async function importRollups(c: Ctx, slug: string): Promise<Response> {
	const denied = await requireAdmin(c, slug);
	if (denied) return denied;

	let rows: DailyRow[];
	try {
		const { rows: raw } = await readObject(c);
		if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMPORT_ROWS) {
			throw new BadRequest(`rows must be an array of 1 to ${MAX_IMPORT_ROWS} items`);
		}
		const today = utcDay();
		const parsed = raw.map((r, i) => parseRow(r, i, today));
		const days = new Set(parsed.map((r) => r.day));
		if (days.size !== parsed.length) throw new BadRequest("rows must not repeat a day");
		rows = parsed.map((r) => ({ ...r, project: slug, source: "import" }));
	} catch (err) {
		if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
		throw err;
	}

	const imported = await upsertDaily(c.env.DB, rows, "import");
	return c.json({ imported, skipped: rows.length - imported });
}

export async function rollupProject(c: Ctx, slug: string): Promise<Response> {
	const denied = await requireAdmin(c, slug);
	if (denied) return denied;

	const today = utcDay();
	const day = c.req.query("day") ?? addDays(today, -1);
	if (!isRealDay(day)) return c.json({ error: "day must be YYYY-MM-DD" }, 400);
	if (day >= today) return c.json({ error: "day must be a finished UTC day" }, 400);
	if (day < addDays(today, -ROLLUP_WINDOW_DAYS)) {
		return c.json({ error: `day must be within the last ${ROLLUP_WINDOW_DAYS} days` }, 400);
	}
	return c.json(await runRollup(c.env, day, slug));
}

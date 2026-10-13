import { getSalt, rememberProject } from "./db.ts";
import { canCreate, NEW_PROJECTS_PER_DAY, NEW_PROJECTS_PER_IP_PER_DAY, noteCreate, noteCreateRefused } from "./guard.ts";
import { addToDims, runRollup, topDims, upsertDaily } from "./rollup.ts";
import type { CreatedProject, Ctx, DailyRow, Dims, Project, RegistryEntry } from "./types.ts";
import { addDays, baseUrl, isValidSlug, randomHex, sha256hex, utcDay } from "./util.ts";

const MAX_NAME = 60;
const MAX_DESCRIPTION = 200;
const MAX_HOMEPAGE = 200;
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

const REGISTRY_DAYS = 30;

/**
 * Public registry: projects with a rollup in the last 30 closed days, so slugs created by junk
 * traffic never show. Sorted by latest DAU, then slug.
 */
export async function queryRegistry(db: D1Database): Promise<RegistryEntry[]> {
	const last = addDays(utcDay(), -1);
	const first = addDays(last, -(REGISTRY_DAYS - 1));
	const { results } = await db
		.prepare(
			`SELECT p.slug, p.name, p.description, p.homepage, p.created_at, d.day, d.dau
			FROM projects p JOIN daily d ON d.project = p.slug
			WHERE d.day BETWEEN ? AND ?`,
		)
		.bind(first, last)
		.all<Project & { day: string; dau: number }>();

	const bySlug = new Map<string, RegistryEntry>();
	for (const { day, dau, ...project } of results) {
		let entry = bySlug.get(project.slug);
		if (!entry) {
			entry = { ...project, series: new Array(REGISTRY_DAYS).fill(0), dau: 0 };
			bySlug.set(project.slug, entry);
		}
		const i = Math.round((Date.parse(day) - Date.parse(first)) / 86_400_000);
		entry.series[i] = dau;
		if (day === last) entry.dau = dau;
	}
	return [...bySlug.values()].sort((a, b) => b.dau - a.dau || (a.slug < b.slug ? -1 : 1));
}

export async function listProjects(c: Ctx): Promise<Response> {
	return c.json({ projects: await queryRegistry(c.env.DB) });
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

const INSERT_NEW_PROJECT = `INSERT INTO projects (slug, admin_hash, created_at, creator)
SELECT ?1, ?2, ?3, ?4
WHERE (SELECT count(*) FROM projects WHERE created_at >= ?5) < ?6
	AND (SELECT count(*) FROM projects WHERE creator = ?4 AND created_at >= ?5) < ?7
ON CONFLICT(slug) DO NOTHING`;

const newToken = (): string => `tk_${randomHex(24)}`;

const capReached = (c: Ctx): Response => c.json({ error: "new project limit reached for today" }, 429);

/**
 * Creates `slug` for its first accepted event. Caps are checked in memory first, then enforced
 * by one conditional INSERT, so they hold across isolates. Null means the project already
 * exists: another request created it first.
 */
export async function autoCreate(c: Ctx, slug: string): Promise<CreatedProject | Response | null> {
	const ip = c.req.header("cf-connecting-ip") ?? "unknown";
	if (!canCreate(ip)) return capReached(c);

	const db = c.env.DB;
	const day = utcDay();
	const creator = (await sha256hex(`${getSalt()}|${day}|${ip}`)).slice(0, 16);
	const token = newToken();
	const { meta } = await db
		.prepare(INSERT_NEW_PROJECT)
		.bind(slug, await sha256hex(token), new Date().toISOString(), creator, day, NEW_PROJECTS_PER_DAY, NEW_PROJECTS_PER_IP_PER_DAY)
		.run();
	if (meta.changes === 1) {
		noteCreate(ip);
		rememberProject(slug, true);
		return { slug, created: true, admin_token: token, page_url: `${baseUrl(c.req.raw)}/${slug}` };
	}

	const row = await db
		.prepare("SELECT EXISTS(SELECT 1 FROM projects WHERE slug = ?) AS hit, (SELECT count(*) FROM projects WHERE created_at >= ?) AS today")
		.bind(slug, day)
		.first<{ hit: number; today: number }>();
	if (row?.hit) {
		rememberProject(slug, true);
		return null;
	}
	noteCreateRefused(ip, (row?.today ?? 0) >= NEW_PROJECTS_PER_DAY);
	return capReached(c);
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

/** `PATCH /api/<slug>`: a missing field stays as it is, null or "" clears it. The slug never changes. */
export async function updateProject(c: Ctx, slug: string): Promise<Response> {
	const denied = await requireAdmin(c, slug);
	if (denied) return denied;

	const set: [column: string, value: string | null][] = [];
	try {
		const body = await readObject(c);
		if ("slug" in body) throw new BadRequest("slug cannot be changed: raw events are stored under it");
		if ("name" in body) set.push(["name", optionalText(body.name, "name", MAX_NAME)]);
		if ("description" in body) set.push(["description", optionalText(body.description, "description", MAX_DESCRIPTION)]);
		if ("homepage" in body) set.push(["homepage", homepageUrl(body.homepage)]);
		if (set.length === 0) throw new BadRequest("send at least one of name, description, homepage");
	} catch (err) {
		if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
		throw err;
	}

	const project = await c.env.DB.prepare(
		`UPDATE projects SET ${set.map(([col]) => `${col} = ?`).join(", ")} WHERE slug = ?
		RETURNING slug, name, description, homepage, created_at`,
	)
		.bind(...set.map(([, v]) => v), slug)
		.first<Project>();
	return c.json({ project });
}

/** `POST /api/<slug>/token`: a new admin token. The old one stops working at once. */
export async function rotateToken(c: Ctx, slug: string): Promise<Response> {
	const denied = await requireAdmin(c, slug);
	if (denied) return denied;
	const token = newToken();
	await c.env.DB.prepare("UPDATE projects SET admin_hash = ? WHERE slug = ?").bind(await sha256hex(token), slug).run();
	c.header("cache-control", "no-store");
	return c.json({ admin_token: token });
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

import { utcDay } from "./util.ts";

// The Workers free quota (100k requests/day) and the Analytics Engine quota
// (100k data points/day) are account-wide, so one noisy client must not eat them all.
export const IP_LIMIT = 60;
export const DAILY_CAP = 20_000;
// Every new slug costs a D1 row, so project creation by first event is capped too.
export const NEW_PROJECTS_PER_IP_PER_DAY = 3;
export const NEW_PROJECTS_PER_DAY = 100;

const WINDOW_MS = 60_000;
const MAX_IPS = 10_000;

const ips = new Map<string, { start: number; count: number }>();
const used = new Map<string, number>();
let usedDay = "";
const creates = new Map<string, number>();
let createsDay = "";
let createsFull = false;

/** Fixed-window limiter, per isolate. */
export function checkIp(ip: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
	if (ips.size > MAX_IPS) ips.clear();
	let w = ips.get(ip);
	if (!w || now - w.start >= WINDOW_MS) {
		w = { start: now, count: 0 };
		ips.set(ip, w);
	}
	w.count++;
	if (w.count <= IP_LIMIT) return { ok: true };
	return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + WINDOW_MS - now) / 1000)) };
}

/** Reserves `points` of the project's UTC-day budget. All or nothing: a refused batch uses none. */
export function reserve(project: string, points: number, now = Date.now()): boolean {
	const day = utcDay(new Date(now));
	if (day !== usedDay) {
		used.clear();
		usedDay = day;
	}
	const total = (used.get(project) ?? 0) + points;
	if (total > DAILY_CAP) return false;
	used.set(project, total);
	return true;
}

function rollCreates(now: number): void {
	const day = utcDay(new Date(now));
	if (day === createsDay) return;
	creates.clear();
	createsFull = false;
	createsDay = day;
}

/** In-memory pre-check for a new project, so spam stops before any D1 call. D1 enforces the same caps durably. */
export function canCreate(ip: string, now = Date.now()): boolean {
	rollCreates(now);
	return !createsFull && (creates.get(ip) ?? 0) < NEW_PROJECTS_PER_IP_PER_DAY;
}

export function noteCreate(ip: string, now = Date.now()): void {
	rollCreates(now);
	if (creates.size > MAX_IPS) creates.clear();
	creates.set(ip, (creates.get(ip) ?? 0) + 1);
}

/** D1 refused a create: remember which cap, so retries stop reaching D1 today. */
export function noteCreateRefused(ip: string, globalFull: boolean, now = Date.now()): void {
	rollCreates(now);
	if (globalFull) {
		createsFull = true;
		return;
	}
	if (creates.size > MAX_IPS) creates.clear();
	creates.set(ip, NEW_PROJECTS_PER_IP_PER_DAY);
}

/** Test hook. */
export function resetGuard(): void {
	ips.clear();
	used.clear();
	usedDay = "";
	creates.clear();
	createsDay = "";
	createsFull = false;
}

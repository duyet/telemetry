import { beforeEach, expect, test } from "bun:test";
import { checkIp, DAILY_CAP, IP_LIMIT, reserve, resetGuard } from "../src/guard.ts";

const NOON = Date.UTC(2026, 9, 13, 12, 0, 0);
const DAY = 86_400_000;

beforeEach(resetGuard);

test("one ip cannot spend more than its per-minute share of the account-wide request quota", () => {
	for (let i = 0; i < IP_LIMIT; i++) expect(checkIp("1.1.1.1", NOON).ok).toBe(true);
	const blocked = checkIp("1.1.1.1", NOON + 10_000);
	expect(blocked).toEqual({ ok: false, retryAfter: 50 });
	expect(checkIp("2.2.2.2", NOON).ok).toBe(true);
});

test("the ip window reopens after a minute so a well-behaved client is never locked out for long", () => {
	for (let i = 0; i <= IP_LIMIT; i++) checkIp("1.1.1.1", NOON);
	expect(checkIp("1.1.1.1", NOON + 59_999).ok).toBe(false);
	expect(checkIp("1.1.1.1", NOON + 60_000).ok).toBe(true);
});

test("a flood of distinct ips cannot grow isolate memory without bound", () => {
	for (let i = 0; i < 10_050; i++) checkIp(`ip-${i}`, NOON);
	// the map was cleared along the way, so an earlier offender starts from zero again
	for (let i = 0; i < IP_LIMIT; i++) expect(checkIp("ip-0", NOON).ok).toBe(true);
});

test("the daily cap stops one project from using the account-wide Analytics Engine quota", () => {
	expect(reserve("a", DAILY_CAP, NOON)).toBe(true);
	expect(reserve("a", 1, NOON)).toBe(false);
	expect(reserve("b", 1, NOON)).toBe(true);
});

test("a refused batch reserves nothing, so smaller batches still fit", () => {
	expect(reserve("a", DAILY_CAP - 5, NOON)).toBe(true);
	expect(reserve("a", 10, NOON)).toBe(false);
	expect(reserve("a", 5, NOON)).toBe(true);
});

test("the daily cap resets when the UTC day changes", () => {
	expect(reserve("a", DAILY_CAP, NOON)).toBe(true);
	expect(reserve("a", 1, NOON + 11 * 3_600_000)).toBe(false);
	expect(reserve("a", 1, NOON + 12 * 3_600_000)).toBe(true);
	expect(reserve("a", DAILY_CAP - 1, NOON + DAY)).toBe(true);
});

import { raw } from "hono/html";
import type { Child } from "hono/jsx";

export const REPO = "https://github.com/duyet/telemetry";

export interface TocEntry {
	id: string;
	label: string;
}

const FAVICON =
	"data:image/svg+xml," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#171717"/><path d="M3 11.5l3-4 3 2 4-5.5" fill="none" stroke="#fafafa" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	);

const TAB_RULES = Array.from(
	{ length: 8 },
	(_, i) => `.tabs>input:nth-of-type(${i + 1}):checked~.panel:nth-of-type(${i + 1}){display:block}`,
).join("");

/*
 * One stylesheet for every page. Light only. Tokens and measures follow the masthead-and-rail
 * layout: a sticky left rail with the table of contents, a 550px reading column, and a right margin
 * that wide figures may extend into.
 */
const CSS = `
@font-face{font-family:"Inter";src:url(/fonts/inter-normal.woff2) format("woff2");font-weight:400 600;font-style:normal;font-display:swap}
@font-face{font-family:"EB Garamond";src:url(/fonts/eb-garamond-italic.woff2) format("woff2");font-weight:400;font-style:italic;font-display:swap}
:root{color-scheme:light;--ground:#fafafa;--ink:#171717;--text-2:#525252;--muted:#8f8f8f;--faint:#bdbdbd;--rule:#ebebeb;--well:#f1f1f1;--well-2:#e7e7e7;--column:550px;--gutter:16px;--rail:168px;--margin:168px;--gap:48px;--sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;--serif:"EB Garamond",Georgia,"Times New Roman",serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--ease:cubic-bezier(.22,.75,.2,1);--card-shadow:0 0 0 1px rgb(0 0 0/.04),0 1px 2px 0 rgb(0 0 0/.04),0 2px 8px -2px rgb(0 0 0/.06)}
*,*::before,*::after{box-sizing:border-box}
html{background:var(--ground);-webkit-text-size-adjust:100%}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:14px;line-height:20.5px;font-weight:450;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;overflow-wrap:anywhere}
::selection{background:#e3e8ef}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--faint);text-decoration-thickness:1px;text-underline-offset:3px;transition:color .15s ease,text-decoration-color .15s ease}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:1px solid var(--ink);outline-offset:3px;border-radius:3px}
h1,h2,h3,h4{margin:0;font-size:14px;line-height:20.5px;font-weight:550}
p{margin:0 0 12px}
em{font-family:var(--serif);font-size:1.16em;font-style:italic;font-weight:400;line-height:1}
strong,b{font-weight:550}
code,kbd{font-family:var(--mono);font-size:12.5px;background:var(--well);border-radius:4px;padding:1px 5px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
button{font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer}
.num{font-variant-numeric:lining-nums tabular-nums;font-feature-settings:"tnum","lnum"}
.muted{color:var(--muted)}
.t2{color:var(--text-2)}
.small{font-size:13px;line-height:20px}
.page{padding:36px var(--gutter) 120px;overflow-x:clip}
.column{max-width:var(--column);margin:0 auto;min-width:0}
.top{margin:0 0 28px;padding:0 0 12px;border-bottom:1px solid var(--rule);font-size:13px;line-height:20px}
.nav{display:flex;flex-wrap:wrap;gap:4px 18px;margin:0;padding:0;list-style:none}
.nav a,.toc a{color:var(--muted);text-decoration:none;transition:color .3s ease}
.nav a:hover,.nav a[aria-current],.toc a:hover,.toc a[aria-current]{color:var(--ink)}
.rail{display:none}
.title-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.title{font-size:14px;line-height:20.5px;font-weight:550}
.title span{color:var(--muted);font-weight:450}
.title a{text-decoration:none}
.social{display:flex;align-items:center;gap:14px;margin:0;padding:0;list-style:none}
.social a{display:inline-flex;color:var(--muted);transition:color .15s ease}
.social a:hover{color:var(--ink)}
.social svg{width:14px;height:14px}
.statement{margin:20px 0 0;font-size:15.5px;line-height:23px;text-wrap:balance}
.masthead-line{display:flex;flex-wrap:wrap;margin:10px 0 0;padding:0;list-style:none;color:var(--muted);font-size:13px;line-height:20px}
.masthead-line li+li::before{content:"·";margin:0 8px;color:var(--faint)}
.masthead-line a{color:inherit}
.masthead-line a:hover{color:var(--ink)}
.lede{margin-top:28px}
.lede p{text-wrap:pretty}
.section{margin-top:64px;scroll-margin-top:48px}
.section-head{display:flex;align-items:center;gap:14px;margin:0 0 20px}
.section-head h2{white-space:nowrap}
.section-head::after{content:"";order:1;flex:1 1 auto;height:1px;background:var(--rule)}
.section-index{order:2;color:var(--muted);font-family:var(--serif);font-size:16px;font-style:italic;line-height:20.5px;font-variant-numeric:lining-nums tabular-nums}
.code{position:relative;margin:16px 0 20px;padding:12px 44px 12px 14px;border-radius:10px;background:#fff;box-shadow:var(--card-shadow);font-family:var(--mono);font-size:12px;line-height:19px}
.code pre{margin:0;font:inherit;white-space:pre;overflow-x:auto;scrollbar-width:none}
.code pre::-webkit-scrollbar{display:none}
.code pre.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
.code code{background:none;padding:0;font:inherit;border-radius:0}
.code .k{color:var(--muted)}
.copy{position:absolute;top:50%;right:8px;display:grid;place-items:center;width:28px;height:28px;border-radius:7px;color:var(--faint);transform:translateY(-50%);transition:color .15s ease,background .15s ease}
.copy:hover{background:var(--well);color:var(--ink)}
.copy[data-done]{color:var(--ink)}
.copy svg{width:14px;height:14px}
.statement em{white-space:nowrap}
.note{color:var(--muted);font-size:13px;line-height:20px}
.links{color:var(--muted);font-size:13px}
.links a+a{margin-left:14px}
.colophon{margin-top:72px;padding-top:18px;border-top:1px solid var(--rule);color:var(--muted);font-size:13px;line-height:20px}
.colophon p{margin:0 0 6px}
@media(min-width:1120px){
.page{display:grid;grid-template-columns:minmax(0,1fr) var(--rail) var(--column) var(--margin) minmax(0,1fr);column-gap:var(--gap);align-items:start;padding-top:56px;padding-bottom:0}
.column{grid-column:3;width:100%;max-width:none;margin:0;padding-bottom:120px}
.top{display:none}
.rail{grid-column:2;grid-row:1;position:sticky;top:56px;display:grid;align-content:start;gap:36px;font-size:13px;line-height:20px}
.rail .nav,.toc{display:grid;gap:6px;margin:0;padding:0;list-style:none}
.wide{width:calc(100% + var(--gap) + var(--margin))}
}
`.replace(/\n/g, "");

/** Styles only this page needs; passed to Layout as `css`. */
export const LANDING_CSS = `
.masthead-strip{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px;margin:22px 0 0;padding:10px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
.masthead-strip a{display:block;min-width:0;text-decoration:none;color:var(--muted);font-size:12.5px;line-height:17px}
.masthead-strip svg{display:block;width:100%;height:auto;transition:transform .4s var(--ease)}
.masthead-strip a:hover svg{transform:translateY(-3px)}
.masthead-strip b{display:block;margin-top:5px;color:var(--ink);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.masthead-strip .num{display:block}
.masthead-empty{margin:22px 0 0;padding:10px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule);color:var(--muted);font-size:13px;line-height:20px}
.steps{margin:0 0 20px;padding:0;list-style:none;display:grid;gap:10px}
.steps li{display:grid;grid-template-columns:28px minmax(0,1fr);align-items:baseline}
.steps li>span:first-child{color:var(--muted);font-family:var(--serif);font-size:16px;font-style:italic;font-variant-numeric:lining-nums tabular-nums}
.rules{display:grid;grid-template-columns:132px minmax(0,1fr);margin:20px 0 24px;padding:0}
.rules dt,.rules dd{margin:0;padding:9px 0;border-top:1px solid var(--rule)}
.rules dt:last-of-type,.rules dd:last-of-type{border-bottom:1px solid var(--rule)}
.rules dt{font-weight:500}
.rules dd{color:var(--text-2)}
.rows{margin:0;padding:0;list-style:none}
.rows li{display:grid;grid-template-columns:72px minmax(0,1fr) auto;gap:14px;align-items:center;padding:10px 0;border-top:1px solid var(--rule)}
.rows li:last-child{border-bottom:1px solid var(--rule)}
.rows svg{display:block;width:72px;height:auto}
.rows .what{min-width:0}
.rows .what a{text-decoration:none;font-weight:500}
.rows .what a:hover{text-decoration:underline}
.rows .what span{display:block;color:var(--muted);font-size:12.5px;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rows .dau{color:var(--text-2);font-size:12.5px;text-align:right;white-space:nowrap}
.rows .dau span{color:var(--muted)}
@media(max-width:520px){.rules{grid-template-columns:1fr}.rules dd{border-top:0;padding-top:0}.rules dt:last-of-type{border-bottom:0}.rows li{grid-template-columns:56px minmax(0,1fr) auto}.rows svg{width:56px}}
@media(max-width:560px){.masthead-strip{grid-template-columns:repeat(3,minmax(0,1fr))}.masthead-strip a:nth-child(n+4){display:none}}
`.replace(/\n/g, "");

/** Styles only this page needs; passed to Layout as `css`. */
export const PROJECT_CSS = `
.tabs{margin:16px 0 0}
.tabs>input{position:absolute;opacity:0;width:0;height:0}
.tabs>label{display:inline-block;color:var(--muted);font-size:13px;line-height:20px;margin:0 14px 0 0;cursor:pointer;transition:color .15s ease}
.tabs>label:hover,.tabs>input:checked+label{color:var(--ink)}
.tabs>input:focus-visible+label{outline:1px solid var(--ink);outline-offset:3px;border-radius:3px}
.tabs>.panel{display:none}${TAB_RULES}
.tabs .code{margin-top:10px}
.range{display:flex;flex-wrap:wrap;gap:0 14px;margin:0;padding:0;list-style:none;color:var(--muted);font-size:13px;line-height:20px}
.range a{text-decoration:none;color:inherit}
.range a:hover,.range a[aria-current]{color:var(--ink)}
figure{margin:0}
.chart{display:block;width:100%;height:auto}
.chart-axis{display:flex;justify-content:space-between;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums}
.chart-axis+.chart{margin-top:6px}
figcaption{margin-top:10px;color:var(--muted);font-size:12px;line-height:18px}
.tbl{margin:0 0 28px}
table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}
th,td{text-align:left;padding:7px 0;border-top:1px solid var(--rule);vertical-align:top}
tr:last-child td{border-bottom:1px solid var(--rule)}
th{color:var(--muted);font-weight:450;font-size:12px;border-top:0}
td.n,th.n{text-align:right;white-space:nowrap;padding-left:16px;color:var(--text-2)}
.bar{display:block;height:2px;background:var(--faint);margin-top:4px;max-width:100%}
.empty{color:var(--muted);padding:12px 0;border-top:1px solid var(--rule);border-bottom:1px solid var(--rule)}
`.replace(/\n/g, "");

/** Styles only this page needs; passed to Layout as `css`. */
export const DOCS_CSS = `
.prose p,.prose ul,.prose ol{margin:0 0 14px}
.prose h1{font-size:15.5px;line-height:23px}
.prose h2{margin-top:56px;scroll-margin-top:48px;display:flex;align-items:center;gap:14px}
.prose h2::after{content:"";flex:1 1 auto;height:1px;background:var(--rule)}
.prose h2+*{margin-top:18px}
.prose h3{margin:28px 0 10px;font-weight:500}
.prose li{margin:4px 0}
.prose pre{margin:16px 0 20px;padding:12px 14px;border-radius:10px;background:#fff;box-shadow:var(--card-shadow);font-family:var(--mono);font-size:12px;line-height:19px;white-space:pre;overflow-x:auto;scrollbar-width:none}
.prose pre code{background:none;padding:0;font:inherit;border-radius:0}
.prose table{display:block;overflow-x:auto;margin:0 0 20px;font-size:13px}
.prose th,.prose td{padding:7px 14px 7px 0}
.prose blockquote{margin:0 0 14px;padding-left:14px;border-left:1px solid var(--rule);color:var(--text-2)}
`.replace(/\n/g, "");


const COPY_SCRIPT = `
document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;
var el=document.querySelector(b.getAttribute("data-copy"));var t=el?el.textContent:"";if(!t)return;
function done(){b.setAttribute("data-done","");setTimeout(function(){b.removeAttribute("data-done")},1400)}
navigator.clipboard.writeText(t).then(done,function(){var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)})});
`.trim();

const COPY_ICON = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/></svg>`;

export const GITHUB_ICON = `<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`;

const SITE_NAV: { href: string; label: string; key: NavKey }[] = [
	{ href: "/", label: "Home", key: "home" },
	{ href: "/#projects", label: "Projects", key: "projects" },
	{ href: "/docs", label: "Docs", key: "docs" },
	{ href: REPO, label: "GitHub", key: "github" },
];

export type NavKey = "home" | "projects" | "docs" | "github";

function SiteNav({ current }: { current?: NavKey }) {
	return (
		<ul class="nav">
			{SITE_NAV.map((n) => (
				<li>
					<a href={n.href} aria-current={n.key === current ? "page" : undefined}>
						{n.label}
					</a>
				</li>
			))}
		</ul>
	);
}

/**
 * Page shell: fonts, tokens, the rail (site nav plus this page's table of contents) and the
 * reading column. Below 1120px the rail is hidden and a one-line site nav sits above the column.
 */
export function Layout({
	title,
	description,
	toc = [],
	current,
	css = "",
	children,
}: {
	title: string;
	description: string;
	/** Sections of this page, in order. Rendered as the rail TOC; each id must exist in `children`. */
	toc?: TocEntry[];
	current?: NavKey;
	/** Page-specific rules appended to the shared stylesheet, so each page ships only the CSS it uses. */
	css?: string;
	children?: Child;
}) {
	return (
		<html lang="en">
			<head>
				<meta charset="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<title>{title}</title>
				<meta name="description" content={description} />
				<link rel="icon" href={FAVICON} />
				<link rel="preload" href="/fonts/inter-normal.woff2" as="font" type="font/woff2" crossorigin="anonymous" />
				<style>{raw(CSS + css)}</style>
			</head>
			<body>
				<div class="page">
					<aside class="rail">
						<nav aria-label="Site">
							<SiteNav current={current} />
						</nav>
						{toc.length > 0 && (
							<ol class="toc" aria-label="On this page">
								{toc.map((t) => (
									<li>
										<a href={`#${t.id}`}>{t.label}</a>
									</li>
								))}
							</ol>
						)}
					</aside>
					<main class="column">
						<nav class="top" aria-label="Site">
							<SiteNav current={current} />
						</nav>
						{children}
					</main>
				</div>
				<script>{raw(COPY_SCRIPT)}</script>
			</body>
		</html>
	);
}

/** Top of every page: name, a muted tagline, icon links on the right, then whatever the page adds (statement, strip, line). */
export function Masthead({
	name,
	href,
	tagline,
	icons,
	children,
}: {
	name: string;
	/** When set, the name links there. */
	href?: string;
	tagline?: string | null;
	icons?: { href: string; label: string; svg: string }[];
	children?: Child;
}) {
	return (
		<header class="masthead">
			<div class="title-row">
				<h1 class="title">
					{href ? <a href={href}>{name}</a> : name}
					{tagline && <span> · {tagline}</span>}
				</h1>
				{icons && icons.length > 0 && (
					<ul class="social">
						{icons.map((i) => (
							<li>
								<a href={i.href} aria-label={i.label} title={i.label}>
									{raw(i.svg)}
								</a>
							</li>
						))}
					</ul>
				)}
			</div>
			{children}
		</header>
	);
}

/** Muted items separated by a faint dot. Pass strings or links. */
export function MastheadLine({ items }: { items: Child[] }) {
	return (
		<ul class="masthead-line">
			{items.map((it) => (
				<li>{it}</li>
			))}
		</ul>
	);
}

/** A page section with a small heading, a hairline and a serif index number. */
export function Section({ id, index, title, children }: { id: string; index: number; title: string; children?: Child }) {
	return (
		<section id={id} class="section">
			<div class="section-head">
				<h2>{title}</h2>
				<span class="section-index num" aria-hidden="true">
					{String(index).padStart(2, "0")}
				</span>
			</div>
			{children}
		</section>
	);
}

/** Two-column definition list with hairlines: label on the left, text on the right. */
export function Rules({ rows }: { rows: [Child, Child][] }) {
	return (
		<dl class="rules">
			{rows.map(([k, v]) => (
				<>
					<dt>{k}</dt>
					<dd>{v}</dd>
				</>
			))}
		</dl>
	);
}

/** A code block with a copy button. `id` must be unique on the page. */
export function CodeBlock({ id, code, lang, wrap }: { id: string; code: string; lang?: string; wrap?: boolean }) {
	return (
		<div class="code">
			<pre class={wrap ? "wrap" : undefined}>
				<code id={id} class={lang ? `language-${lang}` : undefined}>
					{code}
				</code>
			</pre>
			<button type="button" class="copy" data-copy={`#${id}`} aria-label="Copy to clipboard" title="Copy">
				{raw(COPY_ICON)}
			</button>
		</div>
	);
}

export function NotFoundView({ what }: { what: string }) {
	return (
		<Layout title="Not found · telemetry" description="Project not found">
			<Masthead name="telemetry" href="/" tagline="usage analytics for open source" />
			<div class="lede">
				<p>
					There is no project called <code>{what}</code>.
				</p>
				<p class="t2">
					Projects are created by their first event: send a POST to <code>/{what}</code> and this page will exist. The{" "}
					<a href="/#how">front page</a> shows how.
				</p>
				<p class="links">
					<a href="/">Home</a>
					<a href="/#projects">Projects</a>
					<a href="/docs">Docs</a>
				</p>
			</div>
		</Layout>
	);
}

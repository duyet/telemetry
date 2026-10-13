import { raw } from "hono/html";
import type { Child } from "hono/jsx";

export const REPO = "https://github.com/duyet/telemetry";

const FAVICON =
	"data:image/svg+xml," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#2563eb"/><path d="M3 11.5l3-4 3 2 4-5.5" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
	);

const TAB_RULES = Array.from(
	{ length: 8 },
	(_, i) => `.tabs>input:nth-of-type(${i + 1}):checked~.panel:nth-of-type(${i + 1}){display:block}`,
).join("");

const CSS = `
:root{color-scheme:light;--fg:#111;--muted:#6b7280;--line:#eaeaea;--accent:#2563eb;--bg:#fff;--code:#f6f6f6}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:anywhere}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
.site-header{border-bottom:1px solid var(--line)}
.site-header .wrap{display:flex;align-items:center;justify-content:space-between;height:56px}
.mark{color:var(--fg);font-weight:600;letter-spacing:-.01em}.mark:hover{text-decoration:none}
.site-header nav a{color:var(--muted);margin-left:20px;font-size:14px}.site-header nav a:hover{color:var(--fg);text-decoration:none}
main{padding:40px 0 64px}
.site-footer{border-top:1px solid var(--line);padding:24px 0;color:var(--muted);font-size:13px}
h1{font-size:30px;line-height:1.2;margin:0 0 8px;letter-spacing:-.02em;font-weight:600}
h2{font-size:18px;line-height:1.3;margin:48px 0 16px;font-weight:600}
h3{font-size:13px;color:var(--muted);font-weight:500;margin:0 0 8px}
p{margin:0 0 12px}
.lead{font-size:18px;color:var(--muted);max-width:620px}
.muted{color:var(--muted)}
.small{font-size:13px}
.meta{font-size:14px;color:var(--muted)}.meta a{color:inherit;text-decoration:underline}
.num{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px}
code{background:var(--code);padding:1px 5px;border-radius:3px}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:12px 14px;margin:0;overflow-x:auto;line-height:1.5;white-space:pre}
pre code{background:none;padding:0}
.code{position:relative;margin:0 0 12px}
.code .copy{position:absolute;top:6px;right:6px}
.code pre{padding-right:72px}
.code pre.wrap{white-space:pre-wrap;overflow-wrap:anywhere}
button,.btn{display:inline-block;font:inherit;font-size:13px;line-height:1.2;padding:6px 12px;border:1px solid var(--line);border-radius:6px;background:#fff;color:var(--fg);cursor:pointer}
button:hover,.btn:hover{border-color:#bbb;text-decoration:none}
button[disabled]{opacity:.6;cursor:default}
.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.primary:hover{border-color:var(--accent)}
form button.primary{font-size:14px;padding:8px 16px}
.row{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
.steps{display:grid;grid-template-columns:minmax(0,1fr);gap:24px;counter-reset:step}
@media(min-width:720px){.steps{grid-template-columns:repeat(3,minmax(0,1fr))}}
.step h3{color:var(--fg);font-size:15px}
.step h3::before{counter-increment:step;content:counter(step) ". ";color:var(--muted)}
.card{border:1px solid var(--line);border-radius:8px;padding:20px}
.kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 12px;border:1px solid var(--line);border-radius:8px;padding:20px;margin:24px 0}
@media(min-width:640px){.kpis{grid-template-columns:repeat(5,minmax(0,1fr))}}
.kpi b{display:block;font-size:28px;line-height:1.1;font-weight:600}
.kpi span{display:block;font-size:13px;color:var(--muted);margin-top:4px}
.kpi small{font-size:12px;color:var(--muted);font-weight:400}
.range{display:inline-flex;border:1px solid var(--line);border-radius:6px;overflow:hidden;font-size:13px}
.range a{color:var(--muted);padding:5px 12px;border-left:1px solid var(--line)}.range a:first-child{border-left:0}
.range a:hover{text-decoration:none;color:var(--fg)}
.range a[aria-current]{background:var(--fg);color:#fff}
figure{margin:0}.chart{display:block;width:100%;height:auto}
figcaption{font-size:13px;color:var(--muted);margin-top:8px}
.legend i{display:inline-block;width:10px;height:10px;vertical-align:-1px;margin-right:4px;border-radius:2px}
.grid2{display:grid;grid-template-columns:minmax(0,1fr);gap:28px 40px}
@media(min-width:720px){.grid2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}
td.n,th.n{text-align:right;white-space:nowrap;padding-left:12px}
tr:last-child td{border-bottom:0}
.bar{display:block;height:3px;background:var(--accent);opacity:.45;border-radius:2px;margin-top:5px;max-width:100%}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:20px;text-align:center}
.tabs{border:1px solid var(--line);border-radius:8px;padding:12px 14px 14px}
.tabs>input{position:absolute;opacity:0;width:0;height:0}
.tabs>label{display:inline-block;font-size:13px;color:var(--muted);padding:4px 10px;border-radius:6px;cursor:pointer;margin:0 2px 8px 0}
.tabs>label:hover{color:var(--fg)}
.tabs>input:checked+label{color:var(--fg);background:var(--code)}
.tabs>input:focus-visible+label{outline:2px solid var(--accent);outline-offset:1px}
.tabs>.panel{display:none}${TAB_RULES}
.tabs .code{margin:0}
form label{display:block;font-size:13px;color:var(--muted);margin:0 0 4px}
form .field{margin-bottom:14px}
input[type=text],input[type=url]{font:inherit;font-size:15px;width:100%;padding:7px 10px;border:1px solid #d4d4d8;border-radius:6px;background:#fff;color:var(--fg)}
input:focus-visible{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.hint{font-size:12px;color:var(--muted);margin-top:4px}
.err{color:#b91c1c;font-size:14px;margin:8px 0 0}
.warn{border-left:3px solid var(--accent);padding:4px 12px;margin:0 0 16px;font-size:14px}
.result dt{font-size:13px;color:var(--muted);margin:14px 0 4px}.result dd{margin:0}
.links{font-size:14px}.links a+a{margin-left:16px}
hr{border:0;border-top:1px solid var(--line);margin:40px 0}
.prose{max-width:760px}
.prose h1{margin-top:0}.prose h2{margin-top:40px;padding-top:0}.prose h3{font-size:15px;color:var(--fg);margin:24px 0 8px}
.prose p,.prose ul,.prose ol{margin:0 0 14px}.prose li{margin:4px 0}
.prose pre{margin:0 0 16px}
.prose table{font-size:14px;margin:0 0 16px;display:block;overflow-x:auto}
.prose th,.prose td{padding:6px 12px 6px 0}
.prose blockquote{margin:0 0 14px;padding-left:14px;border-left:3px solid var(--line);color:var(--muted)}
.notfound{text-align:center;padding:40px 0}
`.replace(/\n/g, "");

const COPY_SCRIPT = `
document.addEventListener("click",function(e){var b=e.target.closest&&e.target.closest("[data-copy]");if(!b)return;
var el=document.querySelector(b.getAttribute("data-copy"));var t=el?el.textContent:"";if(!t)return;
navigator.clipboard.writeText(t).then(function(){var o=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=o},1200)},function(){b.textContent="Press Ctrl+C";
var r=document.createRange();r.selectNodeContents(el);var s=getSelection();s.removeAllRanges();s.addRange(r)})});
`.trim();

export function Layout({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
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
				<style>{raw(CSS)}</style>
			</head>
			<body>
				<header class="site-header">
					<div class="wrap">
						<a class="mark" href="/">
							telemetry
						</a>
						<nav aria-label="Site">
							<a href="/#projects">Projects</a>
							<a href="/docs">Docs</a>
							<a href={REPO}>GitHub</a>
						</nav>
					</div>
				</header>
				<main>
					<div class="wrap">{children}</div>
				</main>
				<footer class="site-footer">
					<div class="wrap">Free, self-hosted on Cloudflare Workers · MIT</div>
				</footer>
				<script>{raw(COPY_SCRIPT)}</script>
			</body>
		</html>
	);
}

/** A code block with a copy button. `id` must be unique on the page. */
export function CodeBlock({ id, code, lang, wrap }: { id: string; code: string; lang?: string; wrap?: boolean }) {
	return (
		<div class="code">
			<button type="button" class="copy" data-copy={`#${id}`} aria-label="Copy to clipboard">
				Copy
			</button>
			<pre class={wrap ? "wrap" : undefined}>
				<code id={id} class={lang ? `language-${lang}` : undefined}>
					{code}
				</code>
			</pre>
		</div>
	);
}

export function NotFoundView({ what }: { what: string }) {
	return (
		<Layout title="Not found · telemetry" description="Project not found">
			<div class="notfound">
				<h1>Project not found</h1>
				<p class="muted">
					There is no project called <code>{what}</code>.
				</p>
				<p>
					<a href="/">Back to the registry</a> · <a href="/#create">Create a project</a>
				</p>
			</div>
		</Layout>
	);
}

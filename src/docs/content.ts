/** All human and agent docs content. One source, rendered as HTML (/docs, project page) and served raw (llms.txt, install.md). Owner: agent D. */

export interface Snippet {
	id: string; // "curl" | "ts" | "rust" | "go" | "python" | "browser" | "otlp" | "shell"
	label: string;
	lang: string;
	code: string;
}

/** API reference markdown (rendered at /docs, appended to /llms.txt). */
export function apiMd(base: string): string {
	return `# API\n\n${base}\n`;
}

/** Project-specific agent playbook served at /<project>/install.md. */
export function installMd(base: string, project: string): string {
	return `# ${project}\n\n${base}\n`;
}

/** Ready-to-paste prompt behind the "Copy agent prompt" button. */
export function agentPrompt(base: string, project: string): string {
	return `${base}/${project}/install.md`;
}

/** Copy-paste client snippets per language for one project. */
export function snippets(base: string, project: string): Snippet[] {
	return [{ id: "curl", label: "curl", lang: "sh", code: `curl -X POST ${base}/${project}` }];
}

export function llmsTxt(base: string): string {
	return base;
}

export function agentsMd(base: string): string {
	return base;
}

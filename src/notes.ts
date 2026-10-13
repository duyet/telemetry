/** Owner: agent C (rendering) with content from agent D (src/docs). */
export function installMd(base: string, project: string): string {
	return `# ${project}\n\n${base}\n`;
}
export function llmsTxt(base: string): string {
	return base;
}
export function agentsMd(base: string): string {
	return base;
}

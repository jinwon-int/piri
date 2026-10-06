/**
 * True when `baseUrl`'s hostname is `domain` or a subdomain of it.
 *
 * Provider compat detection used to test `baseUrl.includes(domain)`, which also
 * matched the domain anywhere else in the URL (path, query, or a longer host such
 * as `api.openai.com.example`). Matching on the parsed hostname keeps the
 * detection tied to the endpoint the request is actually sent to.
 * Unparseable URLs match nothing.
 */
export function baseUrlHostIs(baseUrl: string, domain: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname;
	} catch {
		return false;
	}
	const target = domain.toLowerCase();
	return hostname === target || hostname.endsWith(`.${target}`);
}

import { describe, expect, it } from "vitest";
import { baseUrlHostIs } from "../src/utils/base-url-host.ts";

describe("baseUrlHostIs", () => {
	it("matches the exact host and its subdomains", () => {
		expect(baseUrlHostIs("https://api.openai.com/v1", "api.openai.com")).toBe(true);
		expect(baseUrlHostIs("https://api.deepseek.com", "deepseek.com")).toBe(true);
		expect(baseUrlHostIs("https://API.DeepSeek.com/v1", "deepseek.com")).toBe(true);
		expect(baseUrlHostIs("https://gateway.ai.cloudflare.com/v1/acct/gw/openai", "gateway.ai.cloudflare.com")).toBe(
			true,
		);
		expect(baseUrlHostIs("https://api.cloudflare.com/client/v4/accounts/x/ai/v1", "api.cloudflare.com")).toBe(true);
	});

	it("does not match the domain outside the hostname", () => {
		expect(baseUrlHostIs("https://proxy.example/api.openai.com/v1", "api.openai.com")).toBe(false);
		expect(baseUrlHostIs("https://proxy.example/v1?to=api.openai.com", "api.openai.com")).toBe(false);
		expect(baseUrlHostIs("https://api.openai.com.example/v1", "api.openai.com")).toBe(false);
		expect(baseUrlHostIs("https://notdeepseek.com/v1", "deepseek.com")).toBe(false);
		expect(baseUrlHostIs("https://api.openai.com@proxy.example/v1", "api.openai.com")).toBe(false);
	});

	it("returns false for unparseable URLs", () => {
		expect(baseUrlHostIs("api.openai.com/v1", "api.openai.com")).toBe(false);
		expect(baseUrlHostIs("", "api.openai.com")).toBe(false);
	});
});

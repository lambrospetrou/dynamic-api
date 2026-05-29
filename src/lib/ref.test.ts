import { describe, expect, it } from "vitest";
import { DEFAULT_CHANNEL, formatRef, generateAppId, parseRef, verifyAppId } from "./ref";

const SECRET = "test-secret";
const ID = "a7kp2mq9blt4bf3rhn8ol2qp1vuc5nd0sjm"; // 35 base32 (0-9a-v), hyphen-free

describe("parseRef", () => {
	it("parses a bare id", () => {
		expect(parseRef(ID)).toEqual({
			appId: ID,
			slug: undefined,
			selector: undefined,
			resolvedSelector: DEFAULT_CHANNEL,
		});
	});

	it("parses id + slug", () => {
		expect(parseRef(`${ID}-weather-bot`)).toEqual({
			appId: ID,
			slug: "weather-bot",
			selector: undefined,
			resolvedSelector: DEFAULT_CHANNEL,
		});
	});

	it("keeps internal hyphens in the slug", () => {
		expect(parseRef(`${ID}-weather-bot-v2`)?.slug).toBe("weather-bot-v2");
	});

	it("parses id + slug + selector", () => {
		expect(parseRef(`${ID}-weather-bot@latest`)).toEqual({
			appId: ID,
			slug: "weather-bot",
			selector: "latest",
			resolvedSelector: "latest",
		});
	});

	it("parses id + selector with no slug", () => {
		expect(parseRef(`${ID}@production`)).toEqual({
			appId: ID,
			slug: undefined,
			selector: "production",
			resolvedSelector: "production",
		});
	});

	it("parses a numeric selector", () => {
		expect(parseRef(`${ID}-weather-bot@7`)?.selector).toBe("7");
	});

	it("treats a trailing '@' or '-' as absent", () => {
		expect(parseRef(`${ID}@`)).toMatchObject({ selector: undefined, slug: undefined });
		expect(parseRef(`${ID}-`)).toMatchObject({ slug: undefined });
	});

	it("returns null for an empty or dashless-garbage leading token", () => {
		expect(parseRef("")).toBeNull();
		expect(parseRef("-weather-bot")).toBeNull(); // empty appId before first '-'
		expect(parseRef("@latest")).toBeNull();
		expect(parseRef("foo@bar@baz")).toBeNull(); // appId "foo@bar" contains '@'
	});
});

describe("formatRef", () => {
	it("joins id and slug", () => {
		expect(formatRef(ID, "weather-bot")).toBe(`${ID}-weather-bot`);
	});

	it("returns just the id when slug is absent or equals the id", () => {
		expect(formatRef(ID)).toBe(ID);
		expect(formatRef(ID, ID)).toBe(ID);
	});

	it("round-trips through parseRef", () => {
		const parsed = parseRef(formatRef(ID, "my-app"));
		expect(parsed?.appId).toBe(ID);
		expect(parsed?.slug).toBe("my-app");
	});
});

describe("generateAppId / verifyAppId", () => {
	it("produces hyphen-free 35-char base32 ids that parseRef accepts as a bare appId", async () => {
		const id = await generateAppId(SECRET);
		expect(id).toMatch(/^[0-9a-v]{35}$/);
		expect(parseRef(id)?.appId).toBe(id);
	});

	it("verifies an id it minted", async () => {
		const id = await generateAppId(SECRET);
		expect(await verifyAppId(SECRET, id)).toBe(true);
	});

	it("rejects a forged id (valid shape, bad tag)", async () => {
		const id = await generateAppId(SECRET);
		const forged = id.slice(0, 34) + (id[34] === "0" ? "1" : "0"); // flip last tag char
		expect(await verifyAppId(SECRET, forged)).toBe(false);
	});

	it("rejects an id minted under a different secret", async () => {
		const id = await generateAppId(SECRET);
		expect(await verifyAppId("other-secret", id)).toBe(false);
	});

	it("rejects malformed ids without computing an HMAC", async () => {
		expect(await verifyAppId(SECRET, "")).toBe(false);
		expect(await verifyAppId(SECRET, "has-a-dash")).toBe(false);
		expect(await verifyAppId(SECRET, ID.slice(0, 16))).toBe(false); // too short
	});
});

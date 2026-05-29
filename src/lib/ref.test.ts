import { describe, expect, it } from "vitest";
import { DEFAULT_CHANNEL, formatRef, generateAppId, parseRef } from "./ref";

const ID = "3f2a4b5c6d7e8f90112233445566778e"; // 32 hex, hyphen-free

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

describe("generateAppId", () => {
  it("produces hyphen-free ids that parseRef accepts as a bare appId", () => {
    const id = generateAppId();
    expect(id).not.toContain("-");
    expect(id).not.toContain("@");
    expect(parseRef(id)?.appId).toBe(id);
  });
});

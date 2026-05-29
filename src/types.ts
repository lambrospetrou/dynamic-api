export type AppVersion = {
	version: number;
	prompt: string;
	code: string;
	created_at: string;
};

export type Visibility = "private" | "public";

export type AppRecord = {
	id: string;
	slug: string;
	description: string;
	visibility: Visibility;
	created_at: string;
	current: AppVersion;
};

export type AppCtx = {
	appId: string;
	workspace: string;
};

export type RegistryAppRecord = {
	id: string;
	slug: string;
	description: string;
	visibility: Visibility;
	current_version: number;
	last_updated: string;
	created_at: string;
};

export type AppToken = {
	id: string;
	label: string | null;
	created_at: string;
};

// A named release channel pointing at a specific version. `latest` is virtual
// (always MAX(version)) and is never stored here.
export type AppChannel = {
	name: string;
	version: number;
	updated_at: string;
};

// A recoverable, auto-rotating token surfaced to the (Cloudflare Access-protected)
// owner for quick manual testing. Unlike AppToken it is stored in plaintext and
// has a short lifetime — see src/lib/testToken.ts.
export type TestToken = {
	token: string;
	expires_at: string;
};

const SYSTEM_PROMPT = `You are a Cloudflare Worker code generator. Output ONLY valid JavaScript — no markdown, no code fences, no explanation.

The code must:
- Import WorkerEntrypoint from "cloudflare:workers"
- Export a named class: export class DynamicHandler extends WorkerEntrypoint
- Implement: async fetch(request) { ... return new Response(...); }
- Use only Web Standard APIs (Request, Response, URL, Headers, fetch, crypto, etc.)
- Not import any external modules or use require()
- Return appropriate HTTP status codes and responses of the correct content type (JSON, HTML, plain text, etc.)
- Handle errors gracefully with try/catch

<example_output>
import { WorkerEntrypoint } from "cloudflare:workers";

export class DynamicHandler extends WorkerEntrypoint {
  	async fetch(request) {
    	try {
			const url = new URL(request.url);
		
			let result;
			// ... custom logic based on the request ...

			return Response.json(result, {
				status: 200
			});
    	} catch (error) {
    		return Response.json({
				message: "dynamic handler error",
				error: String(error),
				errorProps: error,
			}, { status: 500 });
    	}
  	}
}
</example_output>
`;

export function validateCode(code: string): boolean {
	return code.includes("export class DynamicHandler") && code.includes("async fetch(");
}

async function callAI(env: Env, userContent: string): Promise<string> {
	const result = (await env.AI.run("anthropic/claude-sonnet-4.6", {
		// const result = await env.AI.run("anthropic/claude-haiku-4.5", {
		system: SYSTEM_PROMPT,
		max_tokens: 15_000,
		temperature: 0.1,
		messages: [{ role: "user", content: userContent }],
	})) as { content: { type: string; text: string }[] };

	return result.content.find((b) => b.type === "text")?.text ?? "";
}

export async function generateCode(
	env: Env,
	description: string,
	previousCode?: string,
): Promise<string> {
	let userContent = description;
	if (previousCode) {
		userContent += `\n\nPrevious version of the code (modify it to satisfy the new description):\n\`\`\`\n${previousCode}\n\`\`\``;
	}

	const code = await callAI(env, userContent);
	if (validateCode(code)) return code;

	const correctionPrompt = `The following code is invalid — it must export a class named DynamicHandler extending WorkerEntrypoint with an async fetch method.\n\nFix it:\n\`\`\`\n${code}\n\`\`\``;
	const retried = await callAI(env, correctionPrompt);

	if (validateCode(retried)) return retried;

	throw new Error("Generated code failed validation after retry");
}

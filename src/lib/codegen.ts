const SYSTEM_PROMPT = `You are a Cloudflare Worker code generator. Output ONLY valid JavaScript — no markdown, no code fences, no explanation.

The code must:
- Import WorkerEntrypoint from "cloudflare:workers"
- Export a named class: export class DynamicHandler extends WorkerEntrypoint
- Implement: async fetch(request) { ... return new Response(...); }
- Use only Web Standard APIs (Request, Response, URL, Headers, fetch, crypto, etc.)
- Not import any external modules or use require()
- Return appropriate HTTP status codes and JSON responses
- Handle errors gracefully with try/catch`;

export function validateCode(code: string): boolean {
  return code.includes("export class DynamicHandler") && code.includes("async fetch(");
}

async function callAI(userContent: string, env: Env): Promise<string> {
  const result = await (env.AI as any).run("anthropic/claude-sonnet-4.6", {
    system: SYSTEM_PROMPT,
    max_tokens: 4096,
    messages: [{ role: "user", content: userContent }],
  }) as { content: { type: string; text: string }[] };

  return result.content.find((b) => b.type === "text")?.text ?? "";
}

export async function generateCode(
  description: string,
  env: Env,
  previousCode?: string,
): Promise<string> {
  let userContent = description;
  if (previousCode) {
    userContent += `\n\nPrevious version of the code (modify it to satisfy the new description):\n\`\`\`\n${previousCode}\n\`\`\``;
  }

  const code = await callAI(userContent, env);
  if (validateCode(code)) return code;

  const correctionPrompt =
    `The following code is invalid — it must export a class named DynamicHandler extending WorkerEntrypoint with an async fetch method.\n\nFix it:\n\`\`\`\n${code}\n\`\`\``;
  const retried = await callAI(correctionPrompt, env);

  if (validateCode(retried)) return retried;

  throw new Error("Generated code failed validation after retry");
}

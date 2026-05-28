import * as v from "valibot";

export const CreateAppSchema = v.object({
  slug: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[a-z0-9-]{1,64}$/, "slug must be lowercase alphanumeric with hyphens, max 64 chars"),
    ),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});

export const UpdateAppSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});

export type CreateAppInput = v.InferOutput<typeof CreateAppSchema>;
export type UpdateAppInput = v.InferOutput<typeof UpdateAppSchema>;

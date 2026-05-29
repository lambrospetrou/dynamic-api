import * as v from "valibot";

export const VisibilitySchema = v.picklist(["private", "public"]);

export const CreateAppSchema = v.object({
  slug: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[a-z0-9-]{1,64}$/, "slug must be lowercase alphanumeric with hyphens, max 64 chars"),
    ),
  ),
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
  visibility: v.optional(VisibilitySchema, "private"),
});

export const UpdateVisibilitySchema = v.object({
  visibility: VisibilitySchema,
});

export const UpdateAppSchema = v.object({
  description: v.pipe(v.string(), v.minLength(1), v.maxLength(4000)),
});

export const MintTokenSchema = v.object({
  label: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(256))),
});

// Channel names share the slug charset. "latest" is reserved (it is a virtual
// channel always equal to MAX(version)) and cannot be assigned.
export const ChannelNameSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9-]{1,64}$/, "channel name must be lowercase alphanumeric with hyphens, max 64 chars"),
  v.notValue("latest", '"latest" is a reserved channel'),
);

export const SetChannelSchema = v.object({
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export type CreateAppInput = v.InferOutput<typeof CreateAppSchema>;
export type UpdateAppInput = v.InferOutput<typeof UpdateAppSchema>;
export type UpdateVisibilityInput = v.InferOutput<typeof UpdateVisibilitySchema>;
export type MintTokenInput = v.InferOutput<typeof MintTokenSchema>;
export type SetChannelInput = v.InferOutput<typeof SetChannelSchema>;

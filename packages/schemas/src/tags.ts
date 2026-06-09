import { z } from "zod";

/**
 * Single tag value schema.
 * Accepts alphanumeric start, followed by alphanumeric, underscore, colon, dot, or hyphen.
 * Maximum 64 characters total (1 leading + up to 63 body chars).
 */
export const TagSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,63}$/, "Invalid tag format");

export type Tag = z.infer<typeof TagSchema>;

/**
 * Array-of-tags schema with lowercase normalization, case-insensitive deduplication,
 * and a ≤20 tag limit. Shared across records, entities, and artifacts.
 */
export const TagsSchema = z
  .array(TagSchema)
  .transform((tags) => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const tag of tags) {
      const lower = tag.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        result.push(lower);
      }
    }
    return result;
  })
  .refine((tags) => tags.length <= 20, "may not have more than 20 tags");

export type Tags = z.infer<typeof TagsSchema>;

import { z } from "zod";

export const FenceSchema = z.object({
  resource: z.string(),
  current_fence: z.number().int(),
});

export type Fence = z.infer<typeof FenceSchema>;

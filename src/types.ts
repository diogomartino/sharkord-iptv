import z from "zod";

export const zStartStreamCommand = z.object({
  sourceUrl: z.url(),
  streamName: z.string().optional(),
});

export type TStartStreamCommand = z.infer<typeof zStartStreamCommand>;

import z from "zod";

export const zStartStreamCommand = z.object({
  sourceUrl: z.url(),
  streamName: z.string().optional(),
});

export type TStartStreamCommand = z.infer<typeof zStartStreamCommand>;

export const zPlayStreamCommand = z.object({
  channelName: z.string().min(1),
});

export type TPlayStreamCommand = z.infer<typeof zPlayStreamCommand>;

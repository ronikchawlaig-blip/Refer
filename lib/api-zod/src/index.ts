import { z } from "zod";

// Minimal hand-written replacement for the generated @workspace/api-zod
// package, which was never committed to GitHub. Only HealthCheckResponse is
// used by the current code (artifacts/api-server/src/routes/health.ts).
export const HealthCheckResponse = z.object({
  status: z.literal("ok"),
});

export type HealthCheckResponse = z.infer<typeof HealthCheckResponse>;

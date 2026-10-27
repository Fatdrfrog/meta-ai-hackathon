/** Deployment switch for the reply runtime: unset means on, any value but "true" means off. */
export function isAiriAutoReplyEnabled(): boolean {
  return (process.env.AIRI_AUTO_REPLY ?? "true").toLowerCase() === "true";
}

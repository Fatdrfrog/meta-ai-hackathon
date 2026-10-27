import { Geologica } from "next/font/google";

// Landing-only display face, shared by the page and the portaled workflow
// explorer. Every subset is self-hosted; only Latin and Cyrillic are
// preloaded, Kazakh letters and the tenge sign load on demand.
export const landingDisplayFont = Geologica({
  subsets: ["latin", "cyrillic"],
  variable: "--font-landing-display",
  display: "swap",
});

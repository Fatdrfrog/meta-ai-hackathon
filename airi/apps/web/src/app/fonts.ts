import { Inter } from "next/font/google";

// Shared by the root layout and global-error.tsx, which replaces that layout
// and would otherwise lose the `--font-inter` variable that `font-sans` uses.
export const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

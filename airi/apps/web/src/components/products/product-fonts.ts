import { Geologica } from "next/font/google";

// Products' display face: Geologica, airi's landing face, as an instance of
// its own so the landing's stays as it is. The Latin and Cyrillic extensions
// are preloaded too: the tenge sign is in latin-ext and Kazakh's letters in
// cyrillic-ext, and loading them later would swap the face mid-demo.
export const productsDisplayFont = Geologica({
  subsets: ["latin", "latin-ext", "cyrillic", "cyrillic-ext"],
  weight: ["500", "600"],
  variable: "--font-products-display",
  display: "swap",
});

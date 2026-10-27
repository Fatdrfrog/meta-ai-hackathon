import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// https://vitejs.dev/config/
export default defineConfig(({ command, mode }) => {
  // Get the entry point from environment variable or default to 'widget'
  const entry = process.env.VITE_ENTRY || "widget";
  const preactRoot = path.resolve(__dirname, "node_modules/preact");

  // Determine file extension based on entry point
  const entryFile =
    entry === "loader"
      ? "loader.ts"
      : entry === "commerce-adapters"
        ? "commerce-adapters.ts"
        : "widget.tsx";
  const isIifeEntry = entry === "loader" || entry === "commerce-adapters";

  return {
    plugins: [preact(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
        // Resolve React-targeted deps straight to Preact files to avoid
        // package-subpath aliasing issues in newer Vite builds.
        react: path.resolve(preactRoot, "compat/dist/compat.mjs"),
        "react-dom": path.resolve(preactRoot, "compat/dist/compat.mjs"),
        "react-dom/client": path.resolve(preactRoot, "compat/client.mjs"),
        "react-dom/test-utils": path.resolve(
          preactRoot,
          "test-utils/dist/testUtils.mjs",
        ),
        "react/jsx-runtime": path.resolve(
          preactRoot,
          "jsx-runtime/dist/jsxRuntime.mjs",
        ),
        "react/jsx-dev-runtime": path.resolve(
          preactRoot,
          "jsx-runtime/dist/jsxRuntime.mjs",
        ),
      },
      dedupe: ["preact", "react", "react-dom"],
    },
    build: {
      lib: {
        entry: path.resolve(__dirname, `src/${entryFile}`),
        name:
          entry === "commerce-adapters"
            ? "AiriCommerceAdapterBundle"
            : "AiriWidget",
        formats: [isIifeEntry ? "iife" : "es"],
        fileName: () => `${entry}.js`,
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: isIifeEntry,
          format: isIifeEntry ? "iife" : "es",
        },
      },
      cssCodeSplit: false,
      minify: "terser",
      sourcemap: true,
      target: "es2015",
    },
    css: {
      postcss: {
        plugins: [],
      },
    },
  };
});

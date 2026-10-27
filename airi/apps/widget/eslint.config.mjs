import configs from "eslint-config-preact";

export default [
  ...configs,
  {
    ignores: ["dist/**", "node_modules/**", "*.config.js", "*.config.mjs"],
  }
];

import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const eslintConfig = [
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
      "no-console": "warn",
    },
  },
  {
    // Mongoose infers a document type from every schema literal without a type
    // argument; across the models that inference was the largest share of the
    // web type-check's memory.
    files: ["src/models/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...[
          "NewExpression[callee.property.name='Schema']:not([typeArguments])",
          "NewExpression[callee.name='Schema']:not([typeArguments])",
        ].map(selector => ({
          selector,
          message:
            "Give the schema a type argument: the stored document type, or Record<string, unknown> when no hook reads typed fields.",
        })),
      ],
    },
  },
  {
    ignores: ["dist/**", "*.config.js", "*.config.mjs"],
  },
];

export default eslintConfig;

import stylistic from "@stylistic/eslint-plugin";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/", "coverage/", "skills/", "action/main.mjs"]),
  tseslint.configs.recommendedTypeChecked,
  // Formatting is checked here, with options that match the layout the code already
  // has: double quotes, semicolons, 2-space indent and trailing commas on multi-line
  // lists.
  stylistic.configs.customize({
    arrowParens: true,
    braceStyle: "1tbs",
    indent: [
      2,
      {
        CallExpression: { arguments: 1 },
        // Multi-line union and intersection members keep the indent they have.
        ignoredNodes: [
          "TSUnionType",
          "TSIntersectionType",
          "TSUnionType > TSTypeLiteral",
          "TSUnionType > TSTypeLiteral *",
        ],
        offsetTernaryExpressions: true,
        SwitchCase: 1,
      },
    ],
    jsx: false,
    quoteProps: "as-needed",
    quotes: "double",
    semi: true,
  }),
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js", "action/rollup.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it"] },
          ],
        },
      ],
      "@stylistic/max-len": ["error", { code: 90 }],
      // Binary operators end a line; ternary and union operators start one.
      "@stylistic/operator-linebreak": [
        "error",
        "after",
        { overrides: { "?": "before", ":": "before", "|": "before" } },
      ],
      // Single quotes stay allowed where they avoid escapes, and template literals stay.
      "@stylistic/quotes": [
        "error",
        "double",
        { avoidEscape: true, allowTemplateLiterals: "always" },
      ],
      "@stylistic/indent-binary-ops": "off",
      "@stylistic/list-style": "off",
      "max-lines": ["error", { max: 1000 }],
    },
  },
);

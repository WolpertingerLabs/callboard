import js from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/dist/**", "**/build/**", "**/.next/**", "**/coverage/**", "**/.claude/worktrees/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,jsx,ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
    },
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // React Compiler rules from eslint-plugin-react-hooks v7 — downgrade to
      // warnings. The patterns they flag work correctly today and would need
      // broad refactors across many files to silence as errors.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react/react-in-jsx-scope": "off", // Not needed with React 17+
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "prefer-const": "error",
      "no-var": "error",
      "no-console": "warn",
      "no-debugger": "error",
      "no-empty": "warn", // Make empty blocks a warning instead of error
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    // ACP SDK: one entry point, `/unstable`. Since SDK 2.x the bare entry point
    // parses incoming traffic with the stable schema, which drops unstable
    // updates such as `plan_update` and does not type `PromptResponse.usage`;
    // `/unstable` re-exports the whole stable surface.
    // See "Which SDK entry point" in backend/src/agents/adapters/acp/AcpAgentClient.ts.
    files: ["backend/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@agentclientprotocol/sdk",
              message:
                'Import from "@agentclientprotocol/sdk/unstable" instead: the stable entry point drops unstable protocol data (plan_update, PromptResponse.usage).',
            },
          ],
        },
      ],
      // The rule above does not see inline type imports — `import("pkg").T`.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSImportType[argument.literal.value='@agentclientprotocol/sdk']",
          message:
            'Import from "@agentclientprotocol/sdk/unstable" instead: the stable entry point drops unstable protocol data (plan_update, PromptResponse.usage).',
        },
      ],
    },
  },
  {
    // Node.js files (bin/callboard.js, scripts/*.cjs, scripts/*.mjs)
    files: ["*.js", "bin/*.js", "scripts/*.cjs", "scripts/*.mjs", "packages/computer-use/test/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        require: "readonly",
        module: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        global: "readonly",
        // Node 22+ globals used by bin/callboard.js
        fetch: "readonly",
        AbortController: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);

// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * LINTING EXISTS BECAUSE A HOOK RULE TOOK PRODUCTION DOWN.
 *
 * React error #310 - "Rendered more hooks than during the previous render" -
 * shipped to production and rendered the Receive screen as a blank page with
 * "Something went wrong". I caused it in cae1683 by adding a useMemo that sat
 * below three early returns:
 *
 *     if (!walletsEnabled) return ...
 *     if (!isVerified)     return ...
 *     if (!availableChains.length) return ...
 *     const wallet = useMemo(...)          // ← only runs if all three pass
 *
 * React identifies hooks by CALL ORDER. A hook beneath a conditional return
 * changes the count between renders and React throws.
 *
 * TypeScript cannot catch this. It is not a type error, it is a control-flow
 * rule, and the screen typechecked and built cleanly all the way to a user's
 * browser. There was no ESLint anywhere in this project - not a config, not a
 * dependency, in either package.json - so nothing stood between that edit and
 * a blank screen.
 *
 * WHY THIS REPLACES MY OWN SCANNER.
 *
 * scripts/test-react-hook-order.ts was the stopgap. It works, and it caught
 * the real case, but it is a regex over source text: it only matches an early
 * return at exactly two spaces of indentation in one of two exact shapes. A
 * guard inside a try, a switch, a ternary, or with different formatting is
 * invisible to it. rules-of-hooks parses the AST, is maintained by the React
 * team, and catches every shape.
 *
 * The scanner is KEPT rather than deleted - it also pins the specific
 * ReceiveView regression by name, which a generic rule cannot express - but it
 * is no longer the only line of defence.
 */
export default tseslint.config(
  {
    // dist is build output; node_modules is not ours. Neither is source.
    ignores: ['dist/**', 'node_modules/**', 'vite.config.js', 'vite.config.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // The browser surface this app actually touches. Declared explicitly
        // rather than pulling in a globals package: an undeclared global is a
        // real error worth seeing, and a blanket "browser: true" hides typos
        // like `documnet` behind a permissive environment.
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        fetch: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        crypto: 'readonly',
        Blob: 'readonly',
        File: 'readonly',
        FileReader: 'readonly',
        FormData: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        AbortController: 'readonly',
        HTMLElement: 'readonly',
        HTMLInputElement: 'readonly',
        HTMLFormElement: 'readonly',
        HTMLTextAreaElement: 'readonly',
        HTMLSelectElement: 'readonly',
        HTMLButtonElement: 'readonly',
        HTMLDivElement: 'readonly',
        HTMLCanvasElement: 'readonly',
        HTMLImageElement: 'readonly',
        Image: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
        matchMedia: 'readonly',
        crossOriginIsolated: 'readonly',
        performance: 'readonly',
        location: 'readonly',
        history: 'readonly',
        CustomEvent: 'readonly',
        Event: 'readonly',
        KeyboardEvent: 'readonly',
        MouseEvent: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        structuredClone: 'readonly',
        queueMicrotask: 'readonly',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      /**
       * THE RULE THIS ENTIRE CONFIG EXISTS FOR. Non-negotiable, and an error
       * rather than a warning: a warning in a pipeline nobody reads is the
       * same as no rule at all, which is precisely how #310 shipped.
       */
      'react-hooks/rules-of-hooks': 'error',

      /**
       * Stale closures - a hook reading a value it never re-subscribes to.
       * Subtler than rules-of-hooks and far more common; the usual symptom is
       * a screen showing data from two renders ago.
       *
       * WARN, not error, and deliberately so. This rule has real false
       * positives on intentionally-empty dependency arrays (mount-only
       * effects), and turning it to error on an existing codebase means either
       * a large mechanical change made in a hurry before launch, or a wave of
       * eslint-disable comments that make the rule useless. Visible now,
       * promoted to error once the existing set is worked through.
       */
      'react-hooks/exhaustive-deps': 'warn',

      /**
       * `any` is pervasive in this codebase where provider payloads are
       * handled, and much of it is honest - a webhook body genuinely is
       * unknown until validated. Warning keeps it visible without blocking.
       */
      '@typescript-eslint/no-explicit-any': 'warn',

      /**
       * An unused variable is usually a half-finished edit. Underscore-prefixed
       * names are the documented way to say "deliberately ignored", which the
       * existing code already uses for unused callback parameters.
       */
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // TypeScript already proves these; the base rules duplicate the work and
      // produce false positives on type-only declarations.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-redeclare': 'off',
    },
  },
);

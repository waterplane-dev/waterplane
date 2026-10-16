// Type-check only. tsc follows the web app's own `./HintChip` import (hints → storage → api), which
// reads Vite's `import.meta.env`; esbuild redirects that import to webview/shims/HintChip.tsx, so
// none of it is bundled. Declaring the field keeps tsc from needing vite/client types.
interface ImportMeta { readonly env: Record<string, any> }

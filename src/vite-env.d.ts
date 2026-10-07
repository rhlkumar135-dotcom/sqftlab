/// <reference types="vite/client" />
//
// Standard Vite ambient types. This file was missing, which is why `tsc --noEmit`
// reported three errors that had nothing to do with each other:
//
//   * `import.meta.env` — "Property 'env' does not exist on type 'ImportMeta'"
//   * `import 'leaflet/dist/leaflet.css'` — "Cannot find module ... for side-effect
//     import"
//
// Both come from the same place: Vite's client types declare `ImportMeta.env` and
// the `*.css` module shape. Without the reference, TypeScript has no idea the app is
// bundled by Vite, so every Vite-specific import reads as an error. leaflet was
// installed and the CSS resolved fine at runtime the whole time — only the type
// layer was missing.

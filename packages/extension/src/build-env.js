// Values a release VARIANT stamps into its own copy of the extension. EMPTY IN A CHECKOUT.
//
// One source tree sometimes has to ship more than one build — a fork with a development and a
// production backend is the case this exists for. `scripts/package-extension.mjs` overwrites this
// file inside each variant's copy, from the `env` that variant declares under `extensionVariants`
// in the root package.json. Nothing ever commits a value here, and nothing in this repository reads
// it: a fork's own code does.
//
// So whoever reads it must treat every key as optional and fall back to their own default — which
// is also exactly what a checkout loaded with "Load unpacked" gets.
export const BUILD_ENV = Object.freeze({});

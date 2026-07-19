// Test double for SvelteKit's $app/environment. Default to dev=true (matches the dev shim). A test
// that needs production behavior overrides it with vi.mock("$app/environment", () => ({ dev: false })).
export const dev = true;
export const building = false;
export const browser = false;
export const version = "test";

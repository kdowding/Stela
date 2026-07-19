// Test double for SvelteKit's $env/dynamic/private — backed by process.env so tests can control
// configuration with vi.stubEnv(...) / process.env before exercising the code under test.
export const env: Record<string, string | undefined> = process.env;

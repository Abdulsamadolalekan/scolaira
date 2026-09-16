// Stub for `server-only` used by vitest. The real `server-only` package
// unconditionally throws — it relies on Next.js/Vite aliasing it away during
// server builds. In our node integration tests we are genuinely on the server,
// so the guard is vacuously satisfied. Client-side (jsdom) unit tests MUST NOT
// import server code (enforced by the project split), so they never hit this.
export default {};

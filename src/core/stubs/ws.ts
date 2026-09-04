// Build-time stub for the Node-only `ws` package (aliased in wxt.config.ts).
//
// Ktor's Kotlin/JS client lazily runs `import('ws')` only under a Node runtime; in the browser and
// the extension service worker it uses the platform WebSocket, so this module is never executed. It
// exists only so the bundler can resolve the dynamic import into a real chunk.

class UnavailableWebSocket {
  constructor() {
    throw new Error('[dmarket-p2p] the Node "ws" package is not available in the browser build');
  }
}

export { UnavailableWebSocket as WebSocket };
export default { WebSocket: UnavailableWebSocket };

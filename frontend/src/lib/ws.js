/**
 * WebSocket client with auto-reconnect.
 * Returns an event emitter-style object.
 */

// Default to same-origin /ws so it works through the dev (vite) and prod (nginx)
// proxies. Override with VITE_WS_URL only for cross-origin setups.
const WS_URL = import.meta.env.VITE_WS_URL
  ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

export function createWSClient(handlers) {
  let ws = null;
  let reconnectTimer = null;
  let closed = false;

  function connect() {
    if (closed) return;
    clearTimeout(reconnectTimer);
    try { ws = new WebSocket(WS_URL); }
    catch { reconnectTimer = setTimeout(connect, 3000); return; }

    ws.onmessage = (e) => {
      try { const msg = JSON.parse(e.data); handlers[msg.type]?.(msg.data); } catch {}
    };
    ws.onclose = () => { if (!closed) reconnectTimer = setTimeout(connect, 3000); };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // After background throttling / Mac sleep, a dead socket can take tens of
  // seconds to fire onclose. When the tab becomes visible again, reconnect
  // immediately if it isn't open/connecting — so the tip catches up at once.
  function onVisible() {
    if (closed || document.hidden) return;
    if (!ws || (ws.readyState !== WebSocket.OPEN && ws.readyState !== WebSocket.CONNECTING)) {
      connect();
    }
  }
  document.addEventListener("visibilitychange", onVisible);

  connect();

  return {
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      document.removeEventListener("visibilitychange", onVisible);
      try { ws?.close(); } catch {}
    },
  };
}

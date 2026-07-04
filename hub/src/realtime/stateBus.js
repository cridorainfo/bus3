const WebSocket = require('ws');
const state = require('../engine/state');

// Pushes live state to every connected phone/display session (spec 4.2). No "locked to one
// session" — it's a shared live view; the last action taken wins, since driver and conductor
// are never working against each other.
function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'state', payload: state.snapshot() }));
  });

  state.on('change', (snapshot) => {
    const msg = JSON.stringify({ type: 'state', payload: snapshot });
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  });

  return wss;
}

module.exports = { attach };

import { openDatabase } from './database.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
const store = openDatabase();
const server = createApp(store);
server.listen(port, process.env.HOST || '127.0.0.1', () => {
  console.log(`Nosh dashboard: http://${process.env.HOST || '127.0.0.1'}:${server.address().port}`);
});
server.on('error', (error) => { console.error(error.message); store.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => { store.close(); process.exit(0); });
    // Browsers may open speculative sockets without sending an HTTP request.
    // Close them too so a local stop/restart does not wait indefinitely.
    server.closeAllConnections();
  });
}

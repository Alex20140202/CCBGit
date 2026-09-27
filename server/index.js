#!/usr/bin/env node
import config from '../config.js';
import { createApp, bootstrap } from './app.js';

const app = createApp();

await bootstrap();

const server = app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n  ${config.site.title}  ·  ${config.site.tagline}`);
  console.log(`  ready on ${url}\n`);
  console.log('  clone urls shown in the UI look like:');
  console.log(`    git clone ${config.baseUrl || url}/<owner>/<repo>.git\n`);
});

server.headersTimeout = 120000;
server.requestTimeout = 0;

/** Shut down cleanly so in-flight requests finish. */
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    console.log(`\n${signal} received, closing server…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 8000).unref();
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandled rejection]', reason);
});

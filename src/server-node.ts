import { serve } from '@hono/node-server';
import app from './index.js';

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 8402;

console.log(`\n======================================================`);
console.log(`🚀 Alpha402 API Server started on http://localhost:${PORT}`);
console.log(`⚡ Payment Protocol: HTTP 402 (L402 Lightning / x402 Base)`);
console.log(`🤖 Agent Discovery: http://localhost:${PORT}/.well-known/agent.json`);
console.log(`📋 OpenAPI Spec:   http://localhost:${PORT}/openapi.json`);
console.log(`======================================================\n`);

serve({
  fetch: app.fetch,
  port: PORT,
});

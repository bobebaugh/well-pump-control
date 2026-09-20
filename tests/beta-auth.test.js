'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

// Run against the actual handlers with no service credential. No successful
// command, database write, token exchange or physical action is exercised.
test('beta mutation routes reject missing and wrong owner passwords before work', async () => {
  const priorToken = process.env.PILOT_INGEST_TOKEN;
  const priorAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.PILOT_INGEST_TOKEN = 'host-test-only-not-a-deployment-secret';
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = '';
  try {
    const routes = [
      ['rules-engine', 'PUT'], ['rules-engine', 'POST'],
      ['rules-admin', 'POST'], ['operator-control', 'POST'],
      ['ingest-power', 'POST'],
      ['ingest-record', 'POST'], ['event-board', 'POST'],
      ['device-sync', 'POST']
    ];
    for (const [name, method] of routes) {
      const { handler } = require(`../cloud/netlify/functions/${name}`);
      for (const headers of [{}, { 'x-pilot-key': 'incorrect-host-test-key' }]) {
        const result = await handler({ httpMethod: method, headers, body: '{invalid' });
        assert.equal(result.statusCode, 401, `${name} ${method} must authenticate before parsing or executing`);
      }
    }
  } finally {
    if (priorToken === undefined) delete process.env.PILOT_INGEST_TOKEN;
    else process.env.PILOT_INGEST_TOKEN = priorToken;
    if (priorAccount === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = priorAccount;
  }
});

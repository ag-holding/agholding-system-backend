require('dotenv').config();
const { db } = require('./src/config/database');
const { decrypt } = require('./src/utils/encryption');

async function getApiKey(accountId) {
  const client = await db('clients').where({ account_id: accountId }).first();
  if (!client || !client.api_key) {
    console.log('No API key found for this client.');
    process.exit(1);
  }
  const apiKey = decrypt(client.api_key);
  console.log(`API Key for client ${accountId}: ${apiKey}`);
  process.exit(0);
}

const accountId = process.argv[2];
if (!accountId) {
  console.log('Usage: node get-client-apikey.js <accountId>');
  process.exit(1);
}

getApiKey(accountId);
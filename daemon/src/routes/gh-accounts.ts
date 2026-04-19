// daemon/src/routes/gh-accounts.ts

import { Hono } from 'hono';
import { createGhAccountService } from '../services/gh-accounts.js';

const ghAccounts = new Hono();
const ghAccountService = createGhAccountService();

// GET /api/gh-accounts — list authenticated GitHub accounts
ghAccounts.get('/api/gh-accounts', async (c) => {
  const accounts = await ghAccountService.listAccounts();
  return c.json({ accounts });
});

export { ghAccounts };

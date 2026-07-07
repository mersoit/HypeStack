import express from 'express';
import { arenaRouter } from './routes/arena.routes';
import { labRouter } from './routes/lab.routes';
import { questRouter } from './routes/quest.routes';
import { vaultRouter } from './routes/vault.routes';

const app = express();

app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'HypeStack API' });
});

// The 4 Pillars
app.use('/api/arena', arenaRouter);   // The Arena (Discovery Feed)
app.use('/api/lab', labRouter);       // The Lab (AI Workspace)
app.use('/api/quest', questRouter);   // The Quest Log (Dispatch Hub)
app.use('/api/vault', vaultRouter);   // The Vault (Financial Ledger)

export { app };

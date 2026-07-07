import * as dotenv from 'dotenv';
dotenv.config();

import { app } from './app';
import { budgetMonitorWorker } from './workers/budget-monitor.worker';
import { escrowReleaseWorker } from './workers/escrow-release.worker';

const PORT = parseInt(process.env.PORT || '3000', 10);

const server = app.listen(PORT, () => {
  console.log(`HypeStack API running on port ${PORT}`);
  budgetMonitorWorker.start();
  escrowReleaseWorker.start();
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  budgetMonitorWorker.stop();
  escrowReleaseWorker.stop();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  budgetMonitorWorker.stop();
  escrowReleaseWorker.stop();
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

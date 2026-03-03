import express from 'express';
import cors from 'cors';
import { MultiAgentOrchestrator } from '../agents/MultiAgentOrchestrator';
import { AgentDecision } from '../agents/BaseAgent';
import * as dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Store recent events for the dashboard
const recentEvents: any[] = [];

export function createDashboardServer(orchestrator: MultiAgentOrchestrator) {
  // Live stats endpoint
  app.get('/api/stats', async (req, res) => {
    try {
      const stats = await orchestrator.getStats();
      res.json({ success: true, data: stats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Recent events endpoint
  app.get('/api/events', (req, res) => {
    res.json({ success: true, data: recentEvents.slice(-20) });
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ success: true, status: 'running', timestamp: new Date().toISOString() });
  });

  // Register event listener
  orchestrator.onDecision = (decision: AgentDecision) => {
    recentEvents.push({
      ...decision,
      id: Date.now(),
    });
    if (recentEvents.length > 50) recentEvents.shift();
  };

  const PORT = 3001;
  app.listen(PORT, () => {
    console.log(`\n[Dashboard] API server running → http://localhost:${PORT}`);
    console.log(`[Dashboard] Open dashboard → file://dashboard.html\n`);
  });

  return app;
}
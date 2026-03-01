import { createServer } from './server';
import { CONFIG } from './config';

const PORT = CONFIG.port;
const SESSIONS_DIR = CONFIG.sessionsDir;
const PUBLIC_DIR = CONFIG.publicDir;
const maxSessionsRaw = CONFIG.maxSessionsRaw;
const maxSessions = Number.isFinite(Number(maxSessionsRaw)) ? Math.max(0, Math.round(Number(maxSessionsRaw))) : 0;

const app = createServer({
  port: PORT,
  sessionsDir: SESSIONS_DIR,
  publicDir: PUBLIC_DIR,
  maxSessions
});

app.listen(PORT, () => {
  console.log(`faustforge server running on http://localhost:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  console.log(`Public directory: ${PUBLIC_DIR}`);
});

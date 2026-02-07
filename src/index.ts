import * as path from 'path';
import { createServer } from './server';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const SESSIONS_DIR = process.env.SESSIONS_DIR || path.join(__dirname, '..', 'sessions');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public');

const app = createServer({
  port: PORT,
  sessionsDir: SESSIONS_DIR,
  publicDir: PUBLIC_DIR,
  maxSessions: 50
});

app.listen(PORT, () => {
  console.log(`faustforge server running on http://localhost:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  console.log(`Public directory: ${PUBLIC_DIR}`);
});

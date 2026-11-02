import { fileURLToPath } from 'node:url';
import { createApplication } from './server.ts';
const port = Number(process.env.PORT || 8080);
const publicOrigin = process.env.PUBLIC_ORIGIN || `http://localhost:${port}`;
if (process.env.NODE_ENV === 'production' && !publicOrigin.startsWith('https://')) throw new Error('Production requires PUBLIC_ORIGIN=https://your-domain');
const app = createApplication({ dataDir: process.env.DATA_DIR || './data', webDir: fileURLToPath(new URL('../modules/web/dist/', import.meta.url)), publicOrigin, secureCookie: publicOrigin.startsWith('https://') });
app.server.listen(port, '0.0.0.0', () => console.log(`Skill Library listening on ${port}; public origin ${publicOrigin}`));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });

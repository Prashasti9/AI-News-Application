// Run a single fetch → brief → notify cycle and exit (useful for cron hosts).
import { refresh } from '../server/pipeline.js';
import { initPush } from '../server/push.js';

initPush();
const stats = await refresh();
console.log(JSON.stringify(stats, null, 2));

// Run a single cycle and exit (useful for cron hosts). In daily-edition mode
// this publishes today's edition immediately, even if one already went out.
import { config } from '../server/config.js';
import { refresh, runEditionIfDue } from '../server/pipeline.js';
import { initPush } from '../server/push.js';
import { closeStore, initStore } from '../server/store.js';

await initStore();
initPush();
const stats = config.storiesPerDay > 0 ? await runEditionIfDue({ force: true }) : await refresh();
console.log(JSON.stringify(stats, null, 2));
await closeStore();

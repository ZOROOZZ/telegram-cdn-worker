# Video Library Worker

API backend for video library using Cloudflare Workers.

## Setup
1. Install: `npm install -g wrangler`
2. Login: `wrangler login`
3. Create KV: `wrangler kv:namespace create VIDEOS`
4. Update wrangler.toml with KV ID
5. Set secrets: `wrangler secret put BOT_TOKEN`
6. Deploy: `wrangler deploy worker.js`

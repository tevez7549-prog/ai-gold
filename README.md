# Mark2 · AI-GOLD (paper)
Claude plans gold trades once per closed H1 bar; hard rules in code; paper fills on M15 bars; random-side twin as benchmark.
Separate from Mark1 / forex-agent. Price feed: mt5/AIBarsEA.mq5 in the Exness terminal (bars only, no orders).
Deploy: Cloudflare Workers Builds (push to main). Secret: ANTHROPIC_API_KEY (dashboard only). D1 ai-gold eb4f7293-d7ca-4a09-b2c7-5a3142e92025.

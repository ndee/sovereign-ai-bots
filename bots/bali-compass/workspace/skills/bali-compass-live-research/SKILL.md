# bali-compass-live-research

Use this skill when the answer depends on current, local, or source-heavy information.

Research routing:
1. Use `web_search` with Brave or Perplexity for laws, visa updates, taxation changes, business setup requirements, banking, current operators, and local news
2. Use `goplaces` for neighborhoods, venues, coworking spaces, restaurants, cafes, clinics, schools, gyms, and place-level due diligence
3. Use `weather` for rainfall, seasonality, trip timing, and near-term travel conditions
4. Use `summarize` when a long article, official page, PDF, or video needs to be compressed into a decision-ready brief

Execution sequence:
1. Clarify the exact decision the user is trying to make
2. Pick the smallest set of live tools needed
3. Collect the evidence
4. Summarize only the parts that affect the user's decision
5. Separate `facts found now`, `stable heuristics`, and `still needs local verification`

Hard rules:
1. Prefer official or primary sources for legal, immigration, and tax topics when using `web_search`
2. For `goplaces`, report tradeoffs such as traffic, walkability, reviews, and opening-hour risk instead of treating ratings as truth
3. For `weather`, convert raw forecast into practical travel advice
4. For `summarize`, keep the final answer grounded in the user's question, not in source-dump recap

# bali-compass-core

Session workflow:
1. Classify the request as `travel`, `relocation`, `immigration`, `life-admin`, `business`, or `bitcoin`
2. Read `references/intake-checklist.md`
3. For current or place-specific questions, read `references/live-research-stack.md` and use the matching OpenClaw capability
4. Read one or two relevant playbooks from `references/`
5. Respond with concrete options, tradeoffs, and next actions
6. Mark volatile legal, tax, banking, or licensing items as `verify current rules`

Core intake:
1. Passport or nationality
2. Time horizon: holiday, scouting trip, months, or multi-year move
3. Income model: job, remote work, founder, investor, retiree, or family-based move
4. Budget range and desired lifestyle
5. Need for strict compliance certainty versus early exploration

Output shape:
1. Recommendation summary
2. Best-fit path options
3. Key risks and unknowns
4. Documents and people to line up next
5. A 30/90-day action plan when the user wants execution help

Tool routing:
1. Use `web_search` with Brave or Perplexity when the answer depends on current rules, local operators, opening hours, pricing, or changing market conditions
2. Use `goplaces` when the user needs concrete neighborhoods, venues, clinics, schools, coworking spaces, cafes, gyms, or local service options
3. Use `weather` when timing, rainfall, dry season, surf season, or trip planning depends on current or forecast weather
4. Use `summarize` after research when a long page, PDF, or video should be condensed into a short decision brief
5. If a preferred capability is unavailable, say so clearly and fall back to workspace guidance plus explicit verification steps

Hard rules:
1. Do not invent fees, validity periods, or legal thresholds when they are not in the workspace
2. Do not imply that tourist activity, visa runs, nominee structures, or informal arrangements are safe by default
3. Do not give tax or legal advice as a definitive answer; give orientation plus a verification list
4. For citizenship, stress that this is a long-horizon, law-driven path that requires current expert review
5. Distinguish clearly between stable local heuristics from the workspace and current facts found via live research
*** Add File: /tmp/sovereign-ai-bots-bali-compass/bots/bali-compass/workspace/skills/bali-compass-live-research/SKILL.md
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

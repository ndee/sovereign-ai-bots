# bitcoin-skill-match-core

Profile intake checklist:
1. Capture `offers`, `seeks`, `region`, and `contactLevel`
2. Ask for settlement preferences and trust links if relevant
3. Update `data/community-state.json`
4. Confirm exactly what was stored

Match query checklist:
1. Parse the requested skill, region, trust degree, and settlement hints
2. Inspect `members`, `requests`, `trustEdges`, `skills`, and `regions`
3. Rank exact skill match above adjacent skills or broad categories
4. Rank 1st degree above 2nd degree above regional fallback
5. Return matches plus a clear next-step intro suggestion

Intro workflow checklist:
1. Check both users' `contactLevel`
2. Share direct contact only if the stored preference allows it
3. Otherwise draft a consent-first Matrix intro
4. Record the intro state in `introductions`

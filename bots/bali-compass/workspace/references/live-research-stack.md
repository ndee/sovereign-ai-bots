# Live Research Stack

Use this reference when the bot needs OpenClaw live capabilities beyond the static workspace playbooks.

Preferred capability mapping:

1. `web_search`
   - provider: Brave or Perplexity
   - use for:
     - current visa or immigration changes
     - tax, licensing, and banking changes
     - current business service providers
     - current events or safety updates
     - pricing or availability that may have moved recently
2. `goplaces`
   - use for:
     - neighborhood and venue research
     - coworking spaces
     - cafes and restaurants
     - clinics, hospitals, gyms, schools
     - airport-adjacent or admin-adjacent practical stops
3. `weather`
   - use for:
     - short-term travel planning
     - seasonal expectations
     - rain and surf timing
     - whether a location is realistic in a given month
4. `summarize`
   - use for:
     - long pages
     - PDFs
     - long-form guides
     - videos or transcripts

Recommended research patterns:

- immigration question:
  - `web_search` current official guidance
  - `summarize` long source pages
  - answer with verification notes
- neighborhood scouting:
  - `goplaces` for candidate venues and service density
  - `weather` if timing matters
  - answer with area tradeoffs
- business setup:
  - `web_search` current regulatory and provider landscape
  - `summarize` long legal/accounting explainers
  - answer with a due-diligence checklist
- Bitcoin lifestyle:
  - `web_search` current local context and community signals
  - `goplaces` for meeting-friendly or work-friendly venues when relevant
  - answer with privacy and operational-security caveats

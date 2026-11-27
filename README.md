# EdgeAI

EdgeAI is a Next.js football-analysis chat app that uses API-Football statistics, a Dixon-Coles Poisson probability model, margin-adjusted odds, and optional LLM explanations.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env.local`.
4. Set `GEMINI_API_KEY`, `FOOTBALL_API_KEY`, and `ODDS_API_KEY`.
5. Run `npm run dev`.

## Environment

- `GEMINI_API_KEY`: Gemini API key; `LLM_API_KEY` remains a fallback.
- `FOOTBALL_API_KEY`: API-Football v3 key; `API_FOOTBALL_KEY` remains a fallback.
- `ODDS_API_KEY`: The Odds API v4 key.

API-Football responses are cached in memory for six hours. The app limits display to picks priced at 1.25 or above and excludes insufficient-data markets.

## Scripts

- `npm run dev` — development server
- `npm run build` — production build
- `npm run lint` — lint
- `npm test` — unit tests

## Model limitations

Probabilities are estimates, not predictions with guaranteed outcomes. The model uses the available team statistics and Poisson scoreline distribution; missing or low-sample API data reduces confidence. Betting carries risk.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the App

```bash
npm start          # starts the Express server (node server.js)
```

Server runs on `http://localhost:3000` (configurable via `PORT` in `.env`). The frontend is served as a static file from `public/index.html`.

## Environment Setup

Copy `.env.example` to `.env` and fill in credentials. The app requires keys for three services:
- **AeroSync** — open banking widget and data APIs
- **Aeropay** — payment platform (merchant user creation)
- **Dwolla** — ACH transfer platform (customer + funding source management)

The `.env` also needs `DWOLLA_MASTER_FUNDING_SOURCE` set to the Dwolla master funding source URL (not in the example file).

## Architecture Overview

**Single-file backend:** All server logic lives in `server.js` — an Express app with 11 REST endpoints, token caching for all 3 APIs (with expiry tracking), and async job polling for long-running AeroSync operations (identity/transactions, up to 90s).

**Single-file frontend:** `public/index.html` is a ~765-line vanilla JS + HTML/CSS single-page app with a 5-screen flow: Welcome → Create Account/Sign In → Link Bank → Home → Success. It renders inside a phone-frame mockup and includes a live debug panel showing all API request/response logs in real time.

**Data persistence:** Users are stored in `users.json` (flat file, newest-first). No database.

## API Endpoint Map

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/users` | List saved users |
| POST | `/api/user` | Create user (triggers Aeropay + Dwolla in parallel) |
| POST | `/api/aerosync/token` | Get AeroSync widget token for a user |
| GET | `/api/aerosync/account/:connectionId` | Account details |
| GET | `/api/aerosync/balance/:connectionId` | Cached balance |
| GET | `/api/aerosync/identity/:connectionId` | Identity (async job) |
| GET | `/api/aerosync/transactions/:connectionId` | Transactions (async job) |
| GET | `/api/dwolla/master` | Get master funding source |
| POST | `/api/dwolla/funding-source` | Create customer funding source |
| POST | `/api/dwolla/transfer` | Initiate ACH transfer |

## Key Patterns in server.js

- **Token caching:** Each API (Aeropay, AeroSync, Dwolla) has its own cached token object. Tokens are refreshed automatically when expired.
- **Async polling:** AeroSync identity and transaction calls return a job ID; `server.js` polls until completion or timeout.
- **Error codes AC-111, AC-114, AC-115:** These are expected AeroSync error codes for manually-linked accounts — handled explicitly, not treated as failures.
- **Debug logging:** Every outbound API call captures request + response and sends it to the frontend via the `/api/*` response payload for display in the debug panel.

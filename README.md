# AeroSync Test App

A local sandbox demo app for testing the AeroSync open banking widget alongside Aeropay user creation and Dwolla ACH transfers. Built as a single-page "PayMe" mobile app mockup running inside an Express server.

## Setup

```bash
cp .env.example .env   # fill in your sandbox credentials
npm install
npm start              # http://localhost:3000
```

## ⚠️ Security Notice — Local Development Only

**This app has no authentication.** Any request to its API endpoints (including `/api/dwolla/transfer`) will execute without requiring a login or token. It is designed to run on `localhost` for personal sandbox testing only.

**Do not:**
- Deploy this app to a public URL or server
- Share your `.env` file (it's gitignored for a reason)
- Use production API credentials with this app

## Architecture

- **`server.js`** — Express backend with 10 REST endpoints, token caching for AeroSync / Aeropay / Dwolla, and async job polling for long-running AeroSync operations
- **`public/index.html`** — Single-file vanilla JS frontend; a 6-screen mobile app mockup with slide transitions and a live API debug panel
- **`users.json`** — Local flat-file user store (gitignored; auto-created on first user registration)

## Environment Variables

See `.env.example` for all required keys. You'll need sandbox credentials for:
- **AeroSync** — open banking widget and data APIs
- **Aeropay** — merchant user creation
- **Dwolla** — ACH customer and transfer management (also requires `DWOLLA_MASTER_FUNDING_SOURCE`)

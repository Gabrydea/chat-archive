# Assistente vocale Florida Roleplay

Bot Discord per assistere vocalmente gli utenti di Florida Roleplay e inoltrare le richieste allo staff.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_TOKEN` — token del bot Discord
- Required secret: `GEMINI_API_KEY` — trascrizione audio e voce del bot
- Optional env: `GEMINI_TTS_MODEL` — modello Gemini TTS alternativo

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/discord.ts` — avvio del client Discord
- `artifacts/api-server/src/bot/voice-assistant.ts` — assistenza vocale, riconoscimento categorie, ping allo staff e timeout
- `artifacts/api-server/src/routes/health.ts` — endpoint `/api/healthz` per monitoraggio

## Architecture decisions

- Il bot usa i canali, ruoli e testo indicati dal server Florida Roleplay come configurazione fissa.
- La trascrizione e la sintesi vocale usano chiamate HTTP server-side a Gemini; le chiavi non arrivano mai al client.
- La musica d'attesa è generata localmente in PCM per evitare asset audio aggiuntivi.
- Un solo utente può aprire una richiesta alla volta; i membri dello staff possono entrare nella VC occupata.

## Product

Il bot resta nella VC di assistenza, accoglie l'utente, ascolta una delle categorie “assistenza generale”, “fake RP” o “partner”, notifica il ruolo corretto nel canale staff e riproduce una musica d'attesa fino all'arrivo dello staff. Dopo 90 secondi senza staff comunica di aprire un ticket.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

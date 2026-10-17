# Florida Roleplay Discord Bot

Bot Discord con assistente vocale per le richieste di supporto di Florida Roleplay.

## Avvio in Replit

```bash
pnpm --filter @workspace/api-server run dev
```

## Configurazione

Imposta i segreti nell'ambiente di esecuzione, non nei file del repository:

- `DISCORD_TOKEN`
- `GEMINI_API_KEY`
- `DATABASE_URL`

Il runtime deve includere Node.js 24, pnpm, `ffmpeg` ed `espeak-ng`. Per la connessione alla voice di Discord serve anche traffico UDP in uscita.

## Struttura

- `artifacts/api-server/src/bot/discord.ts` — avvio del client Discord
- `artifacts/api-server/src/bot/voice-assistant.ts` — assistenza vocale e instradamento delle richieste
- `artifacts/api-server` — servizio API e bot
- `lib/` — pacchetti condivisi del workspace

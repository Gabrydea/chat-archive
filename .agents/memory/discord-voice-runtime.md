---
name: Discord voice runtime
description: Runtime requirement discovered while connecting the Florida Roleplay Discord voice assistant.
---

Discord voice cannot complete its session when the runtime can reach the Discord gateway but cannot receive the UDP IP-discovery response from the voice server.

**Why:** The bot successfully logs in and has Connect, Speak, and Move Members permissions, while `@discordjs/voice` remains in signalling/connecting until its ready-state timeout.

**How to apply:** Keep the voice assistant code, but run it on a runtime that permits outbound UDP to Discord voice servers before debugging Gemini transcription, TTS, or user routing.

The assistant must not start TTS or create an active support session while the voice connection is still signalling or connecting. If a requester is already in the channel, re-check them after the connection reaches Ready.

**Why:** A requester can enter during a reconnect window; starting playback against an unready player causes a misleading audio-player timeout and makes the bot appear unresponsive.

**How to apply:** Gate `handleUserJoined` on the Ready state and scan existing channel members after a successful reconnect.
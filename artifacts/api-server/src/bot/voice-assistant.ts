import {
  AudioPlayer,
  AudioPlayerStatus,
  AudioResource,
  EndBehaviorType,
  StreamType,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  Client,
  GuildMember,
  PermissionFlagsBits,
  type PermissionResolvable,
  VoiceState,
} from "discord.js";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import prism from "prism-media";
import { logger } from "../lib/logger";

const VOICE_CHANNEL_ID = "1553352208106655774";
const STAFF_REVIEW_CHANNEL_ID = "1553134469723062402";
const FAKE_RP_ROLE_ID = "1553791776937214133";
const GENERAL_SUPPORT_ROLE_ID = "1553791825498734683";
const PARTNER_ROLE_ID = "1553791853768482846";
const STAFF_PERMISSION = PermissionFlagsBits.ManageGuild;
const STAFF_WAIT_MS = 90_000;
const SPEECH_TIMEOUT_MS = 15_000;
const GEMINI_TRANSCRIPTION_MODEL =
  process.env["GEMINI_TRANSCRIPTION_MODEL"] ?? "gemini-2.5-flash-lite";
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const LOCAL_TTS_VOICE = "it";
const GREETING_TEXT =
  "Ciao, sono il bot di assistenza di Florida Roleplay. Ti assisterò. Se vuoi parlare in VC con lo staff dimmi il tuo problema: assistenza generale, fake RP o partner.";
const CONFIRMATION_TEXT =
  "Bene, chiamerò lo staff apposito ed entrerà in VC.";
const MISSED_AUDIO_TEXT =
  "Non ho sentito la risposta. Ripeti: assistenza generale, fake RP o partner.";
const UNKNOWN_REQUEST_TEXT =
  "Non ho capito il problema. Ripeti: assistenza generale, fake RP o partner.";
const INVALID_REQUEST_TEXT =
  "Non ho ricevuto una richiesta valida. Puoi riprovare entrando di nuovo in VC.";
const STAFF_TIMEOUT_TEXT =
  "Ci spiace, ma uno staff non è ora disponibile. È richiesto aprire un ticket.";

type SupportKey = "fake-rp" | "general" | "partner";

type SupportType = {
  key: SupportKey;
  label: string;
  roleId: string;
};

type ActiveSession = {
  userId: string;
  staffArrived: boolean;
  timeout: NodeJS.Timeout | null;
  waitingResource: AudioResource | null;
};

const SUPPORT_TYPES: SupportType[] = [
  { key: "fake-rp", label: "fake RP", roleId: FAKE_RP_ROLE_ID },
  {
    key: "general",
    label: "assistenza generale",
    roleId: GENERAL_SUPPORT_ROLE_ID,
  },
  { key: "partner", label: "partner", roleId: PARTNER_ROLE_ID },
];

let activeSession: ActiveSession | null = null;
let voiceConnection: VoiceConnection | null = null;
let audioPlayer: AudioPlayer | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let waitingMusicListener: (() => void) | null = null;
let starting = false;
const speechPcmCache = new Map<string, Promise<Buffer>>();

export async function startVoiceAssistant(client: Client): Promise<void> {
  client.on("voiceStateUpdate", (oldState, newState) => {
    void handleVoiceStateUpdate(client, oldState, newState).catch(
      (error: unknown) => {
        logger.error({ err: error }, "Failed to handle voice assistant state");
      },
    );
  });

  await connectToSupportChannel(client);
}

async function connectToSupportChannel(client: Client): Promise<void> {
  if (starting || isConnectedToSupportChannel()) {
    return;
  }

  const channel = await client.channels.fetch(VOICE_CHANNEL_ID);
  if (!channel || !channel.isVoiceBased() || channel.type !== 2) {
    throw new Error(
      `Voice support channel ${VOICE_CHANNEL_ID} was not found or is not a voice channel.`,
    );
  }

  const botMember = await channel.guild.members.fetchMe();
  const channelPermissions = botMember.permissionsIn(channel);
  const requiredPermissions: Array<[string, PermissionResolvable]> = [
    ["Connect", PermissionFlagsBits.Connect],
    ["Speak", PermissionFlagsBits.Speak],
    ["MoveMembers", PermissionFlagsBits.MoveMembers],
  ];
  const missingPermissions = requiredPermissions
    .filter(([, permission]) => !channelPermissions.has(permission))
    .map(([name]) => name);
  if (missingPermissions.length > 0) {
    throw new Error(
      `The Discord bot is missing voice permissions in ${VOICE_CHANNEL_ID}: ${missingPermissions.join(", ")}`,
    );
  }

  logger.info(
    {
      voiceChannelId: channel.id,
      guildId: channel.guild.id,
      botPermissions: {
        connect: channelPermissions.has(PermissionFlagsBits.Connect),
        speak: channelPermissions.has(PermissionFlagsBits.Speak),
        moveMembers: channelPermissions.has(PermissionFlagsBits.MoveMembers),
      },
    },
    "Preparing Discord voice connection",
  );

  starting = true;
  try {
    voiceConnection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    audioPlayer = createAudioPlayer();
    voiceConnection.subscribe(audioPlayer);
    voiceConnection.on("stateChange", (oldState, newState) => {
      logger.debug(
        {
          oldStatus: oldState.status,
          newStatus: newState.status,
        },
        "Discord voice connection state changed",
      );
    });
    voiceConnection.on("error", (error) => {
      logger.error({ err: error }, "Discord voice connection error");
    });
    voiceConnection.on("debug", (message) => {
      logger.debug({ message }, "Discord voice debug");
    });

    voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
      scheduleReconnect(client);
    });
    voiceConnection.on(VoiceConnectionStatus.Destroyed, () => {
      scheduleReconnect(client);
    });

    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20_000);
    logger.info({ voiceChannelId: VOICE_CHANNEL_ID }, "Voice assistant connected");

    const existingRequester = channel.members.find(
      (candidate) => !candidate.user.bot && !isStaffMember(candidate),
    );
    if (existingRequester) {
      void handleUserJoined(client, existingRequester.voice).catch(
        (error: unknown) => {
          logger.error(
            { err: error, userId: existingRequester.id },
            "Failed to start support session for existing voice member",
          );
        },
      );
    }
  } catch (error) {
    voiceConnection?.destroy();
    logger.error(
      {
        err: error,
        voiceChannelId: VOICE_CHANNEL_ID,
        hint: "Discord voice requires outbound UDP access from the runtime.",
      },
      "Could not establish the Discord voice session",
    );
    scheduleReconnect(client);
    return;
  } finally {
    starting = false;
  }
}

async function handleVoiceStateUpdate(
  client: Client,
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  if (newState.id === client.user?.id) {
    if (newState.channelId !== VOICE_CHANNEL_ID) {
      scheduleReconnect(client);
    }
    return;
  }

  const joinedSupportChannel =
    newState.channelId === VOICE_CHANNEL_ID &&
    oldState.channelId !== VOICE_CHANNEL_ID;
  if (joinedSupportChannel) {
    await handleUserJoined(client, newState);
  }

  if (
    activeSession &&
    activeSession.userId === oldState.id &&
    oldState.channelId === VOICE_CHANNEL_ID &&
    newState.channelId !== VOICE_CHANNEL_ID
  ) {
    clearActiveSession();
  }

  if (
    activeSession &&
    newState.channelId === VOICE_CHANNEL_ID &&
    isStaffMember(newState.member)
  ) {
    activeSession.staffArrived = true;
    stopWaitingMusic();
    logger.info(
      { userId: newState.id, requesterId: activeSession.userId },
      "Support staff joined the voice request",
    );
  }
}

async function handleUserJoined(
  client: Client,
  state: VoiceState,
): Promise<void> {
  const member = state.member ?? (await fetchGuildMember(state));
  if (!member || member.user.bot) {
    return;
  }

  if (activeSession && activeSession.userId !== member.id && !isStaffMember(member)) {
    await member.voice.disconnect("Support voice channel is currently occupied");
    return;
  }

  if (activeSession) {
    return;
  }

  const connection = voiceConnection;
  const player = audioPlayer;
  if (
    !connection ||
    !player ||
    connection.state.status !== VoiceConnectionStatus.Ready
  ) {
    logger.warn(
      { userId: member.id, voiceChannelId: VOICE_CHANNEL_ID },
      "Ignoring voice support request until the Discord voice connection is ready",
    );
    return;
  }

  const channel = state.channel;
  const staffAlreadyPresent =
    channel?.isVoiceBased() &&
    channel.members.some((candidate) => isStaffMember(candidate));
  const session: ActiveSession = {
    userId: member.id,
    staffArrived: Boolean(staffAlreadyPresent),
    timeout: null,
    waitingResource: null,
  };
  activeSession = session;

  try {
    await playSpeech(
      player,
      GREETING_TEXT,
    );
    const supportType = await listenForSupportType(connection, member.id, player);
    if (!supportType || activeSession?.userId !== member.id) {
      return;
    }

    await playSpeech(
      player,
      CONFIRMATION_TEXT,
    );
    await notifyStaff(client, supportType);
    startWaitingMusic(player, session);

    if (!session.staffArrived) {
      session.timeout = setTimeout(() => {
        void handleStaffTimeout(client, member.id);
      }, STAFF_WAIT_MS);
    }
  } catch (error) {
    logger.error({ err: error, userId: member.id }, "Voice support session failed");
    clearActiveSession();
  }
}

async function listenForSupportType(
  connection: VoiceConnection,
  userId: string,
  player: AudioPlayer,
): Promise<SupportType | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const audio = await captureUserAudio(connection, userId);
    if (!audio) {
      await playSpeech(player, MISSED_AUDIO_TEXT);
      continue;
    }

    const transcript = await transcribeAudio(audio);
    logger.info({ transcript }, "Discord support request transcribed");
    const supportType = findSupportType(transcript);
    if (supportType) {
      return supportType;
    }

    await playSpeech(player, UNKNOWN_REQUEST_TEXT);
  }

  await playSpeech(player, INVALID_REQUEST_TEXT);
  return null;
}

async function captureUserAudio(
  connection: VoiceConnection,
  userId: string,
): Promise<Buffer | null> {
  const startedSpeaking = await waitForUserToStartSpeaking(connection, userId);
  if (!startedSpeaking) {
    return null;
  }

  const opusStream = connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1_000,
    },
  });
  const decoder = new prism.opus.Decoder({
    rate: 48_000,
    channels: 2,
    frameSize: 960,
  });
  const pcmChunks: Buffer[] = [];
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    opusStream.destroy();
    decoder.destroy();
  }, SPEECH_TIMEOUT_MS);

  try {
    opusStream.pipe(decoder);
    for await (const chunk of decoder) {
      pcmChunks.push(Buffer.from(chunk as Uint8Array));
    }
  } finally {
    clearTimeout(timeout);
    opusStream.destroy();
    decoder.destroy();
  }

  if (timedOut || pcmChunks.length === 0) {
    return null;
  }

  return createWavFile(Buffer.concat(pcmChunks), 48_000, 2);
}

async function transcribeAudio(audio: Buffer): Promise<string> {
  const data = await callGemini(GEMINI_TRANSCRIPTION_MODEL, {
    contents: [
      {
        parts: [
          {
            text: "Ascolta l'audio e identifica una sola categoria. Rispondi esclusivamente con una di queste tre frasi: assistenza generale, fake RP, partner.",
          },
          {
            inlineData: {
              mimeType: "audio/wav",
              data: audio.toString("base64"),
            },
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 8,
      temperature: 0,
    },
  });

  return extractGeminiText(data).trim().toLocaleLowerCase("it-IT");
}

async function playSpeech(player: AudioPlayer, text: string): Promise<void> {
  const pcm = await getSpeechPcm(text);
  const resource = createAudioResource(Readable.from([pcm]), {
    inputType: StreamType.Raw,
  });
  player.play(resource);
  await waitForPlayerIdle(player);
}

async function getSpeechPcm(text: string): Promise<Buffer> {
  const cached = speechPcmCache.get(text);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const wav = await synthesizeLocalSpeech(text);
    return convertWavToDiscordPcm(wav);
  })();
  speechPcmCache.set(text, pending);

  try {
    return await pending;
  } catch (error) {
    speechPcmCache.delete(text);
    throw error;
  }
}

function synthesizeLocalSpeech(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const speaker = spawn("espeak-ng", [
      "--stdout",
      "-v",
      LOCAL_TTS_VOICE,
      "-s",
      "155",
      text,
    ]);
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    speaker.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    speaker.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    speaker.once("error", reject);
    speaker.once("close", (code) => {
      if (code !== 0 || chunks.length === 0) {
        reject(
          new Error(
            `Local Italian TTS failed with code ${code}: ${Buffer.concat(errorChunks).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

function convertWavToDiscordPcm(wav: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "wav",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ]);
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    ffmpeg.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    ffmpeg.stderr.on("data", (chunk: Buffer) => errorChunks.push(chunk));
    ffmpeg.once("error", reject);
    ffmpeg.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `ffmpeg audio conversion failed with code ${code}: ${Buffer.concat(errorChunks).toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    ffmpeg.stdin.end(wav);
  });
}

async function notifyStaff(
  client: Client,
  supportType: SupportType,
): Promise<void> {
  const channel = await client.channels.fetch(STAFF_REVIEW_CHANNEL_ID);
  if (!channel || !channel.isTextBased() || !("send" in channel)) {
    throw new Error(`Staff review channel ${STAFF_REVIEW_CHANNEL_ID} is unavailable.`);
  }

  await channel.send({
    content: `Hey <@&${supportType.roleId}> sei atteso in <#${VOICE_CHANNEL_ID}>. Problema: ${supportType.label}.`,
    allowedMentions: { roles: [supportType.roleId] },
  });
}

function startWaitingMusic(
  player: AudioPlayer,
  session: ActiveSession,
): void {
  stopWaitingMusic();
  const resource = createAudioResource(Readable.from([createWaitingMusic()]), {
    inputType: StreamType.Raw,
  });
  session.waitingResource = resource;
  player.play(resource);
  waitingMusicListener = () => {
    if (activeSession !== session || session.staffArrived) {
      return;
    }
    const nextResource = createAudioResource(
      Readable.from([createWaitingMusic()]),
      { inputType: StreamType.Raw },
    );
    session.waitingResource = nextResource;
    player.play(nextResource);
  };
  player.on(AudioPlayerStatus.Idle, waitingMusicListener);
}

function stopWaitingMusic(): void {
  if (audioPlayer && activeSession?.waitingResource) {
    audioPlayer.stop();
    activeSession.waitingResource = null;
  }
  if (audioPlayer && waitingMusicListener) {
    audioPlayer.off(AudioPlayerStatus.Idle, waitingMusicListener);
  }
  waitingMusicListener = null;
}

async function handleStaffTimeout(
  _client: Client,
  userId: string,
): Promise<void> {
  if (!activeSession || activeSession.userId !== userId || activeSession.staffArrived) {
    return;
  }

  const player = audioPlayer;
  if (player) {
    stopWaitingMusic();
    await playSpeech(player, STAFF_TIMEOUT_TEXT);
  }
  clearActiveSession();
}

function clearActiveSession(): void {
  if (!activeSession) {
    return;
  }
  if (activeSession.timeout) {
    clearTimeout(activeSession.timeout);
  }
  stopWaitingMusic();
  activeSession = null;
}

function findSupportType(transcript: string): SupportType | null {
  const normalized = transcript
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("it-IT");

  return (
    SUPPORT_TYPES.find((supportType) => {
      if (supportType.key === "fake-rp") {
        return normalized.includes("fake") || normalized.includes("fak rp");
      }
      if (supportType.key === "general") {
        return normalized.includes("assistenza") || normalized.includes("generale");
      }
      return normalized.includes("partner");
    }) ?? null
  );
}

function isStaffMember(member: GuildMember | null): boolean {
  return Boolean(member?.permissions.has(STAFF_PERMISSION));
}

async function fetchGuildMember(
  state: VoiceState,
): Promise<GuildMember | null> {
  try {
    return await state.guild.members.fetch(state.id);
  } catch {
    return null;
  }
}

function scheduleReconnect(client: Client): void {
  if (reconnectTimer) {
    return;
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectToSupportChannel(client).catch((error: unknown) => {
      logger.error({ err: error }, "Failed to reconnect voice assistant");
    });
  }, 30_000);
}

function isConnectedToSupportChannel(): boolean {
  return Boolean(
    voiceConnection &&
      voiceConnection.state.status === VoiceConnectionStatus.Ready &&
      voiceConnection.joinConfig.channelId === VOICE_CHANNEL_ID,
  );
}

async function callGemini(
  model: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for voice support.");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response;
  try {
    response = await fetch(`${GEMINI_API_URL}/${model}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const responseText = await response.text();
    logger.error(
      {
        model,
        status: response.status,
        response: responseText.slice(0, 500),
      },
      "Gemini voice request failed",
    );
    throw new Error(`Gemini request failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function extractGeminiText(data: unknown): string {
  const candidates = data as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return (
    candidates.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("") ?? ""
  );
}

function findAudioPart(
  data: unknown,
): { data: string; mimeType: string } | null {
  const candidates = data as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          inlineData?: { data?: string; mimeType?: string };
        }>;
      };
    }>;
  };
  for (const part of candidates.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      return {
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType ?? "",
      };
    }
  }
  return null;
}

function parseSampleRate(mimeType: string): number {
  const match = /rate[=/](\d+)/i.exec(mimeType);
  return match ? Number(match[1]) : 24_000;
}

function createWavFile(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function createWaitingMusic(): Buffer {
  const sampleRate = 48_000;
  const durationSeconds = 2;
  const samples = sampleRate * durationSeconds;
  const pcm = Buffer.alloc(samples * 2 * 2);
  const notes = [440, 523.25, 659.25, 523.25];

  for (let index = 0; index < samples; index += 1) {
    const note = notes[Math.floor((index / sampleRate) * 2) % notes.length];
    const envelope = Math.min(
      1,
      index / (sampleRate * 0.03),
      (samples - index) / (sampleRate * 0.03),
    );
    const sample =
      Math.sin((2 * Math.PI * note * index) / sampleRate) * envelope * 0.12;
    const value = Math.round(sample * 32_767);
    pcm.writeInt16LE(value, index * 4);
    pcm.writeInt16LE(value, index * 4 + 2);
  }

  return pcm;
}

function waitForUserToStartSpeaking(
  connection: VoiceConnection,
  userId: string,
): Promise<boolean> {
  const speaking = connection.receiver.speaking;
  if (speaking.users.has(userId)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(false);
    }, SPEECH_TIMEOUT_MS);
    const onStart = (startedUserId: string) => {
      if (startedUserId !== userId) {
        return;
      }
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      speaking.off("start", onStart);
    };
    speaking.on("start", onStart);
  });
}

function waitForPlayerIdle(player: AudioPlayer): Promise<void> {
  if (player.state.status === AudioPlayerStatus.Idle) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onIdle = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      player.off(AudioPlayerStatus.Idle, onIdle);
      player.off("error", onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Audio player timed out while playing speech."));
    }, 20_000);

    player.once(AudioPlayerStatus.Idle, onIdle);
    player.once("error", onError);
  });
}
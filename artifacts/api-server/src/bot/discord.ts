import {
  Client,
  Events,
  GatewayIntentBits,
} from "discord.js";
import { logger } from "../lib/logger";
import { startVoiceAssistant } from "./voice-assistant";

export async function startDiscordBot(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    throw new Error("DISCORD_TOKEN is required to start the Discord bot.");
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  });

  // Interaction handler for slash commands (e.g. /ssu)
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;

      if (interaction.commandName === "ssu") {
        const colore = interaction.options.getString("colore", true);
        const map: Record<string, string> = {
          verde: "✅ Verde",
          giallo: "🟡 Giallo",
          rosso: "🔴 Rosso",
        };
        const stato = map[colore] ?? colore;
        await interaction.reply({ content: `Hai selezionato: ${stato}`, ephemeral: true });
      }
    } catch (err) {
      logger.error({ err }, "Failed to handle interaction");
    }
  });

  client.once(Events.ClientReady, (readyClient) => {
    void startVoiceAssistant(readyClient).catch((error: unknown) => {
      logger.error({ err: error }, "Failed to start voice support assistant");
    });
    logger.info(
      { botUser: readyClient.user.tag },
      "Florida Roleplay Discord bot is ready",
    );
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  await client.login(token);
}

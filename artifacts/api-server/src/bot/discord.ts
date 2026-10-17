import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { logger } from "../lib/logger";
import { startVoiceAssistant } from "./voice-assistant";

const STAFF_ROLE_ID = process.env["STAFF_ROLE_ID"] ?? "1553669607712227398"; // puoi sovrascrivere con env
const ROLE_MENTION = `<@&${STAFF_ROLE_ID}>`;

// testuali in lowercase (small caps richiesti dall'utente -> usiamo lowercase)
const PANEL_TITLE = "ticket e assistenza";
const PANEL_DESC = "ciao, benvenuto nell'area ticket. clicca 'apri' per creare un ticket di assistenza.";

function parseMentionOrName(input: string, guild: any) {
  const trimmed = input.trim();
  // role mention <@&id>
  const roleMatch = trimmed.match(/^<@&(\d+)>$/);
  if (roleMatch) return { type: "role", id: roleMatch[1], mention: `<@&${roleMatch[1]}>` };
  // user mention <@!id> or <@id>
  const userMatch = trimmed.match(/^<@!?(\d+)>$/);
  if (userMatch) return { type: "user", id: userMatch[1], mention: `<@${userMatch[1]}>` };
  // raw id
  const idMatch = trimmed.match(/^(\d{17,19})$/);
  if (idMatch) {
    const id = idMatch[1];
    // try role
    const role = guild.roles?.cache?.get(id);
    if (role) return { type: "role", id, mention: `<@&${id}>` };
    // try member
    const member = guild.members?.cache?.get(id);
    if (member) return { type: "user", id, mention: `<@${id}>` };
    return { type: "id", id, mention: id };
  }
  // try finding role by name (case insensitive)
  const roleByName = guild.roles?.cache?.find((r: any) => r.name?.toLowerCase() === trimmed.toLowerCase());
  if (roleByName) return { type: "role", id: roleByName.id, mention: `<@&${roleByName.id}>` };
  // try finding member by username or nickname
  const memberByName = guild.members?.cache?.find((m: any) => {
    const uname = m.user?.username?.toLowerCase() ?? "";
    const nick = m.nickname?.toLowerCase() ?? "";
    return uname === trimmed.toLowerCase() || nick === trimmed.toLowerCase();
  });
  if (memberByName) return { type: "user", id: memberByName.id, mention: `<@${memberByName.id}>` };

  return null;
}

export async function startDiscordBot(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    throw new Error("DISCORD_TOKEN is required to start the Discord bot.");
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  // gestione interazioni (slash, button, modal)
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // comando slash /ticket -> invia il pannello pubblico con bottone apri (rosso)
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "ticket") {
          const guildName = interaction.guild?.name ?? "server";
          const embed = new EmbedBuilder()
            .setTitle(PANEL_TITLE)
            .setDescription(PANEL_DESC)
            .setColor(0x2f3136)
            .setFooter({ text: guildName });

          const open = new ButtonBuilder()
            .setCustomId("ticket_open")
            .setLabel("apri")
            .setStyle(ButtonStyle.Danger);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(open);

          // invia embed pubblico; poi rimuoviamo la reply del comando per "cancellare" la tua invocazione
          await interaction.reply({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
          // cancella la reply del bot (in modo che non rimanga quella che si genera dal comando)
          await interaction.deleteReply().catch(() => null);
          return;
        }
      }

      // bottone apri -> mostra modal per descrizione
      if (interaction.isButton()) {
        if (interaction.customId === "ticket_open") {
          const modal = new ModalBuilder().setCustomId("ticket_modal").setTitle("apri ticket");
          const input = new TextInputBuilder()
            .setCustomId("descrizione")
            .setLabel("breve descrizione del problema")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setPlaceholder("scrivi qui la tua richiesta di assistenza");
          const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input as any);
          modal.addComponents(row as any);
          await interaction.showModal(modal);
          return;
        }

        if (interaction.customId === "ticket_add") {
          // mostra modal per inserire mention o role name
          const modal = new ModalBuilder().setCustomId("ticket_add_modal").setTitle("aggiungi utente/ruolo");
          const input = new TextInputBuilder()
            .setCustomId("mention")
            .setLabel("inserisci menzione utente o ruolo (@utente o @ruolo) oppure il nome del ruolo")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setPlaceholder("es. @mario o @staff o staff");
          const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input as any);
          modal.addComponents(row as any);
          await interaction.showModal(modal);
          return;
        }

        if (interaction.customId === "ticket_close") {
          // only allow members with ManageChannels or the staff role
          const memberPerms = interaction.memberPermissions;
          const isAdmin = memberPerms?.has(PermissionFlagsBits.ManageChannels);
          const hasStaffRole = (interaction.member as any)?.roles?.cache?.has(STAFF_ROLE_ID);

          if (!isAdmin && !hasStaffRole) {
            await interaction.reply({ content: "non autorizzato", ephemeral: true });
            return;
          }

          const channel = interaction.channel;
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({ content: "impossibile trovare il canale del ticket", ephemeral: true });
            return;
          }

          await interaction.reply({ content: "chiudo e elimino il canale...", ephemeral: true });
          // slight delay to let reply deliver
          setTimeout(async () => {
            try {
              await channel.delete("ticket chiuso da staff");
            } catch (e) {
              logger.error({ err: e }, "failed to delete ticket channel");
            }
          }, 1000);
          return;
        }
      }

      // modal submit
      if (interaction.isModalSubmit()) {
        if (interaction.customId === "ticket_modal") {
          const descrizione = interaction.fields.getTextInputValue("descrizione");
          const guild = interaction.guild;
          const member = interaction.member;
          if (!guild || !interaction.guildId) {
            await interaction.reply({ content: "errore: context mancante", ephemeral: true });
            return;
          }

          // compute next ticket number
          const channels = await guild.channels.fetch();
          let max = 0;
          channels.forEach((ch) => {
            if (ch.name) {
              const m = ch.name.match(/^ticket-(\d+)$/);
              if (m) {
                const n = Number(m[1]);
                if (!Number.isNaN(n) && n > max) max = n;
              }
            }
          });
          const next = max + 1;
          const channelName = `ticket-${next}`;

          // permission overwrites: deny everyone, allow user, allow staff role if present
          const overwrites: any[] = [
            {
              id: guild.id,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: (interaction.user as any).id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
            },
          ];

          if (STAFF_ROLE_ID) {
            overwrites.push({ id: STAFF_ROLE_ID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
          }

          const created = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            permissionOverwrites: overwrites,
            reason: `ticket aperto da ${interaction.user.id}`,
          });

          const ticketEmbed = new EmbedBuilder()
            .setTitle(`ticket ${next}`)
            .setDescription(`utente: <@${interaction.user.id}>\n\ndescrizione:\n${descrizione}`)
            .setColor(0x2f3136)
            .setFooter({ text: guild.name ?? "server" })
            .setTimestamp();

          // bottoni: close e aggiungi
          const closeButton = new ButtonBuilder().setCustomId("ticket_close").setLabel("close ticket").setStyle(ButtonStyle.Secondary);
          const addButton = new ButtonBuilder().setCustomId("ticket_add").setLabel("aggiungi").setStyle(ButtonStyle.Primary);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(closeButton, addButton);

          await created.send({ content: `<@${interaction.user.id}> ${ROLE_MENTION}`, embeds: [ticketEmbed], components: [row], allowedMentions: { users: [interaction.user.id], roles: [STAFF_ROLE_ID] } });

          await interaction.reply({ content: `ticket creato: ${created}`, ephemeral: true });
          return;
        }

        if (interaction.customId === "ticket_add_modal") {
          const value = interaction.fields.getTextInputValue("mention");
          const guild = interaction.guild;
          if (!guild) {
            await interaction.reply({ content: "errore: contesto mancante", ephemeral: true });
            return;
          }

          const resolved = parseMentionOrName(value, guild);
          if (!resolved) {
            await interaction.reply({ content: "impossibile risolvere l'utente/ruolo. usa @menzione o nome ruolo esatto", ephemeral: true });
            return;
          }

          const channel = interaction.channel;
          if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({ content: "errore: questo modal deve essere usato dentro un ticket", ephemeral: true });
            return;
          }

          try {
            if (resolved.type === "user") {
              // aggiungi permesso al membro
              await channel.permissionOverwrites.edit(resolved.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
              await channel.send({ content: `aggiunto: <@${resolved.id}>`, allowedMentions: { users: [resolved.id] } });
            } else if (resolved.type === "role") {
              await channel.permissionOverwrites.edit(resolved.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
              await channel.send({ content: `aggiunto ruolo: <@&${resolved.id}>`, allowedMentions: { roles: [resolved.id] } });
            } else {
              await interaction.reply({ content: "tipo non gestito", ephemeral: true });
              return;
            }

            await interaction.reply({ content: `aggiunta eseguita: ${resolved.mention}`, ephemeral: true });
          } catch (e) {
            logger.error({ err: e }, "failed to add overwrite");
            await interaction.reply({ content: "errore durante l'aggiunta", ephemeral: true });
          }
          return;
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to handle interaction");
    }
  });

  client.once(Events.ClientReady, (readyClient) => {
    void startVoiceAssistant(readyClient).catch((error: unknown) => {
      logger.error({ err: error }, "Failed to start voice support assistant");
    });
    logger.info({ botUser: readyClient.user.tag }, "Florida Roleplay Discord bot is ready");
  });

  client.on(Events.Error, (error) => {
    logger.error({ err: error }, "Discord client error");
  });

  await client.login(token);
}

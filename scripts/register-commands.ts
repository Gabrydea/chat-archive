import { REST, Routes } from "discord.js";

const commands = [
  {
    name: "ssu",
    description: "pubblica lo stato del server",
    options: [
      {
        name: "colore",
        description: "verde, giallo o rosso",
        type: 3,
        required: true,
        choices: [
          { name: "verde", value: "verde" },
          { name: "giallo", value: "giallo" },
          { name: "rosso", value: "rosso" },
        ],
      },
    ],
  },
];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.GUILD_ID;

  if (!token || !appId) {
    throw new Error("DISCORD_TOKEN e DISCORD_APP_ID richiesti");
  }

  const rest = new REST({ version: "10" }).setToken(token);

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), {
      body: commands,
    });
    console.log("comandi registrati nella guild:", guildId);
  } else {
    await rest.put(Routes.applicationCommands(appId), {
      body: commands,
    });
    console.log("comandi registrati globali");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

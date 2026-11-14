import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";

function log(server: string, user: string, message: string) {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  console.log(`[${time}] ${server} | ${user} | ${message}`);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("Join your voice channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("disconnect")
    .setDescription("Disconnect the bot from the voice channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

client.once("clientReady", async () => {
  // Register commands in every server the bot is already in
  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(commands);
  }
});

// Register commands when the bot is added to a new server
client.on("guildCreate", async (guild) => {
  await guild.commands.set(commands);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const server = interaction.guild.name;
  const user = interaction.user.username;

  // Safety net: only admins can use any command
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    log(server, user, `${interaction.commandName} denied`);
    return interaction.reply({
      content: "Only admins can use this command.",
      ephemeral: true,
    });
  }

  if (interaction.commandName === "join") {
    await interaction.deferReply(); // acknowledge right away

    const member = interaction.member as GuildMember;
    const channel = member.voice.channel;
    if (!channel) {
      log(server, user, "join failed: user not in voice");
      return interaction.editReply("Join a voice channel first.");
    }

    // One bot can only be in one voice channel per server
    if (getVoiceConnection(channel.guild.id)) {
      log(server, user, "join failed: already connected");
      return interaction.editReply(
        "I am already connected in this server. Use /disconnect first."
      );
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    connection.on("error", (err) => log(server, user, `voice error: ${err.message}`));

    // Handle disconnects (bot moved or connection dropped)
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // Discord moved the bot or it is reconnecting by itself
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      log(server, user, `join #${channel.name}`);
      await interaction.editReply(`Joined ${channel.name}`);
    } catch {
      log(server, user, `join failed: #${channel.name}`);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      await interaction.editReply("Could not connect to the voice channel.");
    }
  }

  if (interaction.commandName === "disconnect") {
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      log(server, user, "disconnect failed: not connected");
      return interaction.reply({
        content: "I am not in a voice channel.",
        ephemeral: true,
      });
    }

    connection.destroy();
    log(server, user, "disconnect");
    await interaction.reply("Disconnected from the voice channel.");
  }
});

client.login(process.env.DISCORD_TOKEN);
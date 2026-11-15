import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from "@discordjs/voice";

const useColor = process.env.NO_COLOR === undefined;

const colors = {
  reset: useColor ? "\x1b[0m" : "",
  dim: useColor ? "\x1b[2m" : "",
  bold: useColor ? "\x1b[1m" : "",
  cyan: useColor ? "\x1b[36m" : "",
  yellow: useColor ? "\x1b[33m" : "",
  red: useColor ? "\x1b[31m" : "",
  magenta: useColor ? "\x1b[35m" : "",
};

function formatTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const levelStyles = {
  INFO:  { label: "INFO ", color: colors.cyan },
  WARN:  { label: "WARN ", color: colors.yellow },
  ERROR: { label: "ERROR", color: colors.red },
};

const u = (name: string) => `${colors.magenta}@${name}${colors.reset}`;

function log(level: keyof typeof levelStyles, server: string, message: string) {
  const time = `${colors.dim}[${formatTime()}]${colors.reset}`;
  const lvl = `${levelStyles[level].color}[${levelStyles[level].label}]${colors.reset}`;
  const srv = `${colors.cyan}[${server}]${colors.reset}`;
  console.log(`${time} ${lvl} ${srv} ${message}`);
}

const logger = {
  info: (server: string, message: string) => log("INFO", server, message),
  warn: (server: string, message: string) => log("WARN", server, message),
  error: (server: string, message: string) => log("ERROR", server, message),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

const commands = [
  new SlashCommandBuilder()
    .setName("summon")
    .setDescription("Summon the bot to your voice channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("dismiss")
    .setDescription("Dismiss the bot from the voice channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

client.once("clientReady", async (readyClient) => {
  logger.info("System", `Ready as ${readyClient.user.tag} (${readyClient.guilds.cache.size} guilds)`);

  for (const guild of readyClient.guilds.cache.values()) {
    try {
      await guild.commands.set(commands);
    } catch (err: any) {
      logger.error(guild.name, `Command sync failed: ${err.message}`);
    }
  }
  logger.info("System", "Commands synced");
});

client.on("guildCreate", async (guild) => {
  logger.info(guild.name, "Joined guild; syncing commands");
  try {
    await guild.commands.set(commands);
  } catch (err: any) {
    logger.error(guild.name, `Command sync failed: ${err.message}`);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const server = interaction.guild.name;
  const user = interaction.user.username;

  // Safety net: only admins can use any command
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    logger.warn(server, `${u(user)} used /${interaction.commandName} (denied: admin only)`);
    return interaction.reply({
      content: "Only admins can use this command.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === "summon" || interaction.commandName === "join") {
    await interaction.deferReply();

    const member = interaction.member as GuildMember;
    const channel = member.voice.channel;
    if (!channel) {
      logger.warn(server, `${u(user)} used /summon (failed: user not in voice)`);
      return interaction.editReply("Join a voice channel first.");
    }

    if (getVoiceConnection(channel.guild.id)) {
      logger.warn(server, `${u(user)} used /summon (failed: bot already connected)`);
      return interaction.editReply(
        "I am already connected in this server. Use /dismiss first."
      );
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    connection.on("error", (err) => {
      logger.error(server, `Voice error: ${err.message}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          logger.warn(server, "Voice connection dropped");
          connection.destroy();
        }
      }
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      logger.info(server, `Connected to #${channel.name} (by ${u(user)})`);
      await interaction.editReply(`Summoned to ${channel.name}`);
    } catch {
      logger.error(server, `Failed to join #${channel.name} (by ${u(user)}: timeout)`);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        connection.destroy();
      }
      await interaction.editReply("Could not connect to the voice channel.");
    }
  }

  if (interaction.commandName === "dismiss" || interaction.commandName === "disconnect") {
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      logger.warn(server, `${u(user)} used /dismiss (failed: bot not connected)`);
      return interaction.reply({
        content: "I am not in a voice channel.",
        flags: MessageFlags.Ephemeral,
      });
    }

    connection.destroy();
    logger.info(server, `Dismissed from voice (by ${u(user)})`);
    await interaction.reply("Dismissed from the voice channel.");
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err: any) => {
  logger.error("System", `Login failed: ${err.message}`);
});
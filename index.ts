import "dotenv/config";
import { Readable } from "node:stream";
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
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
} from "@discordjs/voice";
import { parseQuranQuery, QuranItem } from "./quran";

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

interface GuildPlayback {
  player: AudioPlayer;
  currentTitle?: string;
  queue: QuranItem[];
}

const guildPlaybacks = new Map<string, GuildPlayback>();

function playNextInQueue(guildId: string, serverName: string) {
  const pb = guildPlaybacks.get(guildId);
  if (!pb) return;

  if (pb.queue.length === 0) {
    if (pb.currentTitle) {
      logger.info(serverName, `Finished playing ${pb.currentTitle}`);
      pb.currentTitle = undefined;
    }
    return;
  }

  const next = pb.queue.shift()!;
  createAudioResourceFromUrl(next.url)
    .then((resource) => {
      const currentPb = guildPlaybacks.get(guildId);
      if (!currentPb || !currentPb.currentTitle) return;

      currentPb.player.play(resource);
    })
    .catch((err) => {
      logger.error(serverName, `Failed to load ${next.title}: ${err.message}`);
      playNextInQueue(guildId, serverName);
    });
}

function attachVoiceListeners(connection: VoiceConnection, guildId: string, serverName: string) {
  connection.on("error", (err) => {
    logger.error(serverName, `Voice error: ${err.message}`);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        logger.warn(serverName, "Voice connection dropped");
        connection.destroy();
      }
      const pb = guildPlaybacks.get(guildId);
      if (pb) {
        pb.queue = [];
        pb.player.stop(true);
        guildPlaybacks.delete(guildId);
      }
    }
  });
}

function getOrCreatePlayer(guildId: string, serverName: string, connection: VoiceConnection): GuildPlayback {
  let pb = guildPlaybacks.get(guildId);
  if (!pb) {
    const player = createAudioPlayer();

    player.on(AudioPlayerStatus.Idle, () => {
      playNextInQueue(guildId, serverName);
    });

    player.on("error", (err) => {
      logger.error(serverName, `Audio error: ${err.message}`);
      playNextInQueue(guildId, serverName);
    });

    connection.subscribe(player);
    pb = { player, queue: [] };
    guildPlaybacks.set(guildId, pb);
  } else {
    connection.subscribe(pb.player);
  }
  return pb;
}

async function createAudioResourceFromUrl(url: string) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to load audio (${res.status} ${res.statusText})`);
  }
  const stream = Readable.fromWeb(res.body as any);
  return createAudioResource(stream);
}

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
  new SlashCommandBuilder()
    .setName("quran-play")
    .setDescription("Play a Surah (e.g. 2), Ayah (e.g. 2:34), or Range (e.g. 2:3-6)")
    .addStringOption((opt) =>
      opt
        .setName("target")
        .setDescription("Surah (e.g. 2), Ayah (e.g. 2:34), or Range (e.g. 2:3-6)")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop Quran audio playback immediately")
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
    attachVoiceListeners(connection, channel.guild.id, server);

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

  if (interaction.commandName === "quran-play") {
    await interaction.deferReply();

    const targetQuery = interaction.options.getString("target", true);
    const parsed = parseQuranQuery(targetQuery);

    if (!parsed.success) {
      logger.warn(server, `${u(user)} used /quran-play (failed: ${parsed.error})`);
      return interaction.editReply(`❌ ${parsed.error}`);
    }

    const member = interaction.member as GuildMember;
    const channel = member.voice.channel;
    if (!channel) {
      logger.warn(server, `${u(user)} used /quran-play (failed: user not in voice)`);
      return interaction.editReply("Join a voice channel first.");
    }

    let connection = getVoiceConnection(interaction.guild.id);

    if (!connection) {
      connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
      });
      attachVoiceListeners(connection, channel.guild.id, server);

      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        logger.info(server, `Connected to #${channel.name} (by ${u(user)})`);
      } catch {
        logger.error(server, `Failed to join #${channel.name} (by ${u(user)}: timeout)`);
        if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
          connection.destroy();
        }
        return interaction.editReply("Could not connect to your voice channel.");
      }
    } else if (connection.joinConfig.channelId !== channel.id) {
      logger.warn(server, `${u(user)} used /quran-play (failed: bot in different channel)`);
      return interaction.editReply("I am already in another voice channel. Use /dismiss first.");
    }

    const pb = getOrCreatePlayer(interaction.guild.id, server, connection);
    pb.queue = [...parsed.target.items];
    pb.currentTitle = parsed.target.title;

    logger.info(server, `Started playing ${parsed.target.title} (by ${u(user)})`);
    playNextInQueue(interaction.guild.id, server);

    await interaction.editReply(`▶️ Now playing **${parsed.target.title}** (Mishary Rashid Alafasy)`);
  }

  if (interaction.commandName === "stop") {
    const pb = guildPlaybacks.get(interaction.guild.id);
    const connection = getVoiceConnection(interaction.guild.id);

    if (!connection || !pb || (pb.player.state.status === AudioPlayerStatus.Idle && pb.queue.length === 0)) {
      logger.warn(server, `${u(user)} used /stop (failed: not playing)`);
      return interaction.reply({
        content: "No audio is currently playing.",
        flags: MessageFlags.Ephemeral,
      });
    }

    pb.queue = [];
    pb.player.stop(true);
    const stoppedTitle = pb.currentTitle;
    pb.currentTitle = undefined;

    logger.info(server, `Playback stopped (by ${u(user)})`);
    return interaction.reply({
      content: `⏹️ Stopped playback${stoppedTitle ? ` of **${stoppedTitle}**` : ""}.`,
    });
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

    const pb = guildPlaybacks.get(interaction.guild.id);
    if (pb) {
      pb.queue = [];
      pb.player.stop(true);
      pb.currentTitle = undefined;
      guildPlaybacks.delete(interaction.guild.id);
    }

    connection.destroy();
    logger.info(server, `Dismissed from voice (by ${u(user)})`);
    await interaction.reply("Dismissed from the voice channel.");
  }
});

client.login(process.env.DISCORD_TOKEN).catch((err: any) => {
  logger.error("System", `Login failed: ${err.message}`);
});

import "dotenv/config";
import { Readable } from "node:stream";
import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");

import {
  Client,
  GatewayIntentBits,
  GuildMember,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  VoiceConnectionDisconnectReason,
  createAudioPlayer,
  createAudioResource,
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
} from "@discordjs/voice";
import { parseQuranQuery, QuranItem } from "./quran";
import { getWeatherForecast, PlaybackItem, createTtsStream } from "./weather";

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
  queueTitle?: string;
  loading: boolean;
  playbackId: number;
  queue: (QuranItem | PlaybackItem)[];
}

const guildPlaybacks = new Map<string, GuildPlayback>();

function stopPlayback(pb: GuildPlayback) {
  pb.playbackId++;
  pb.loading = false;
  pb.queue = [];
  pb.queueTitle = undefined;
  pb.currentTitle = undefined;
  pb.player.stop(true);
}

async function getAudioResourceForItem(item: QuranItem | PlaybackItem) {
  if ("getStream" in item && typeof item.getStream === "function") {
    const stream = await item.getStream();
    return createAudioResource(stream);
  }
  if (item.url) {
    return createAudioResourceFromUrl(item.url);
  }
  throw new Error("Invalid playback item: missing url or getStream");
}

function playNextInQueue(guildId: string, serverName: string) {
  const pb = guildPlaybacks.get(guildId);
  if (!pb) return;

  if (pb.queue.length === 0) {
    pb.currentTitle = undefined;
    pb.queueTitle = undefined;
    pb.loading = false;
    return;
  }

  const next = pb.queue.shift()!;
  const currentPlaybackId = ++pb.playbackId;
  pb.loading = true;
  pb.currentTitle = pb.queueTitle ?? next.title;

  getAudioResourceForItem(next)
    .then((resource) => {
      const currentPb = guildPlaybacks.get(guildId);
      if (!currentPb || currentPb.playbackId !== currentPlaybackId) {
        resource.playStream.destroy();
        return;
      }

      currentPb.loading = false;
      currentPb.player.play(resource);
    })
    .catch((err) => {
      const currentPb = guildPlaybacks.get(guildId);
      if (!currentPb || currentPb.playbackId !== currentPlaybackId) return;

      currentPb.loading = false;
      logger.error(serverName, `Failed to load ${next.title}: ${err.message}`);
      playNextInQueue(guildId, serverName);
    });
}

function cleanupGuildPlayback(guildId: string) {
  const pb = guildPlaybacks.get(guildId);
  if (pb) {
    stopPlayback(pb);
    guildPlaybacks.delete(guildId);
  }
}

function attachVoiceListeners(connection: VoiceConnection, guildId: string, serverName: string) {
  connection.on("error", (err) => {
    logger.error(serverName, `Voice error: ${err.message}`);
  });

  connection.on(VoiceConnectionStatus.Destroyed, () => {
    cleanupGuildPlayback(guildId);
  });

  connection.on(VoiceConnectionStatus.Disconnected, async (_oldState, newState) => {
    if (newState.reason === VoiceConnectionDisconnectReason.Manual) {
      return;
    }

    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      return;
    } catch {
      if (connection.state.status === VoiceConnectionStatus.Destroyed) return;

      const is4014 =
        newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
        newState.closeCode === 4014;

      if (!is4014 && connection.rejoinAttempts < 5) {
        const reasonLabel =
          newState.reason === VoiceConnectionDisconnectReason.WebSocketClose
            ? `ws:${newState.closeCode}`
            : VoiceConnectionDisconnectReason[newState.reason];
        logger.warn(
          serverName,
          `Voice connection interrupted (${reasonLabel}); attempting rejoin (${connection.rejoinAttempts + 1}/5)`
        );
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        if (connection.state.status === VoiceConnectionStatus.Disconnected) {
          connection.rejoin();
        }
        return;
      }

      logger.warn(
        serverName,
        is4014
          ? "Voice connection closed (code 4014); disconnecting"
          : "Voice connection dropped after rejoin attempts"
      );
      connection.destroy();
      cleanupGuildPlayback(guildId);
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
    pb = { player, loading: false, playbackId: 0, queue: [] };
    guildPlaybacks.set(guildId, pb);
  } else {
    connection.subscribe(pb.player);
  }
  return pb;
}

async function createAudioResourceFromUrl(url: string) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    },
  });
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Failed to load audio (${res.status} ${res.statusText})`);
  }
  const stream = Readable.fromWeb(res.body as any);
  return createAudioResource(stream);
}

async function ensureConnectedToMember(
  interaction: any,
  server: string,
  user: string
): Promise<{ channel: any; connection: VoiceConnection } | null> {
  const member = interaction.member as GuildMember;
  const channel = member.voice.channel;
  if (!channel) {
    logger.warn(server, `${u(user)} used /${interaction.commandName} (failed: user not in voice)`);
    if (interaction.deferred) {
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({ content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: "Join a voice channel first.", flags: MessageFlags.Ephemeral });
    }
    return null;
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
      if (interaction.deferred) {
        await interaction.deleteReply().catch(() => {});
        await interaction.followUp({ content: "Could not connect to your voice channel.", flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: "Could not connect to your voice channel.", flags: MessageFlags.Ephemeral });
      }
      return null;
    }
  } else if (connection.joinConfig.channelId !== channel.id) {
    logger.warn(server, `${u(user)} used /${interaction.commandName} (failed: bot in different channel)`);
    if (interaction.deferred) {
      await interaction.deleteReply().catch(() => {});
      await interaction.followUp({
        content: "I am already in another voice channel. Use /dismiss first.",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: "I am already in another voice channel. Use /dismiss first.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return null;
  }

  return { channel, connection };
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.on("error", (err) => {
  logger.error("Discord", `Client error: ${err.message}`);
});

client.on("warn", (msg) => {
  logger.warn("Discord", msg);
});

const commands = [
  new SlashCommandBuilder()
    .setName("summon")
    .setDescription("Summon the bot to your voice channel"),
  new SlashCommandBuilder()
    .setName("dismiss")
    .setDescription("Dismiss the bot from the voice channel"),
  new SlashCommandBuilder()
    .setName("quran-play")
    .setDescription("Play a Surah (e.g. 2), Ayah (e.g. 2:34), or Range (e.g. 2:3-6)")
    .addStringOption((opt) =>
      opt
        .setName("target")
        .setDescription("Surah (e.g. 2), Ayah (e.g. 2:34), or Range (e.g. 2:3-6)")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("weather-today")
    .setDescription("Play today's weather forecast in voice (default: Dhaka & Rangpur)")
    .addStringOption((opt) =>
      opt
        .setName("location")
        .setDescription("City name or zip code (optional, defaults to Dhaka & Rangpur)")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("weather-week")
    .setDescription("Play 7-day weekly weather forecast in voice (default: Dhaka & Rangpur)")
    .addStringOption((opt) =>
      opt
        .setName("location")
        .setDescription("City name or zip code (optional, defaults to Dhaka & Rangpur)")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("weather")
    .setDescription("Play weather forecast in voice (default: Dhaka & Rangpur)")
    .addStringOption((opt) =>
      opt
        .setName("timeframe")
        .setDescription("Forecast timeframe: today or week (default: today)")
        .setRequired(false)
        .addChoices(
          { name: "Today", value: "today" },
          { name: "Week (7-day)", value: "week" }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName("location")
        .setDescription("City name or zip code (optional, defaults to Dhaka & Rangpur)")
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("tts")
    .setDescription("Say text out loud in the voice channel")
    .addStringOption((opt) =>
      opt
        .setName("text")
        .setDescription("The text to say out loud")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Stop audio playback immediately"),
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

client.on("voiceStateUpdate", async (oldState, newState) => {
  try {
    const guild = newState.guild || oldState.guild;
    if (!guild) return;

    const connection = getVoiceConnection(guild.id);
    if (!connection) return;

    const botChannelId = connection.joinConfig.channelId;
    if (!botChannelId) return;

    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const userEntered = newState.channelId === botChannelId && oldState.channelId !== botChannelId;
    const userLeft = oldState.channelId === botChannelId && newState.channelId !== botChannelId;

    if (!userEntered && !userLeft) return;

    const name = member.displayName || member.user.username;
    const message = userEntered ? `${name} entered the room.` : `${name} left the room.`;

    logger.info(guild.name, `${u(member.user.username)} ${userEntered ? "entered" : "left"} voice channel`);

    const pb = getOrCreatePlayer(guild.id, guild.name, connection);
    const isIdle = pb.player.state.status === AudioPlayerStatus.Idle && !pb.loading;
    const item: PlaybackItem = {
      title: message,
      getStream: () => createTtsStream(message),
    };

    pb.queue.push(item);

    if (isIdle) {
      pb.queueTitle = undefined;
      playNextInQueue(guild.id, guild.name);
    }
  } catch (err: any) {
    logger.error("Voice", `Voice update error: ${err.message}`);
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.guild) return;

  const server = interaction.guild.name;
  const user = interaction.user.username;

  try {
    if (interaction.commandName === "summon" || interaction.commandName === "join") {
      const member = interaction.member as GuildMember;
      const channel = member.voice.channel;
      if (!channel) {
        logger.warn(server, `${u(user)} used /summon (failed: user not in voice)`);
        await interaction.reply({
          content: "Join a voice channel first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (getVoiceConnection(channel.guild.id)) {
        logger.warn(server, `${u(user)} used /summon (failed: bot already connected)`);
        await interaction.reply({
          content: "I am already connected in this server. Use /dismiss first.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

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
        await interaction.deleteReply().catch(() => {});
        await interaction.followUp({
          content: "Could not connect to the voice channel.",
          flags: MessageFlags.Ephemeral,
        });
      }
      return;
    }

    if (interaction.commandName === "quran-play") {
      const targetQuery = interaction.options.getString("target", true);
      const parsed = parseQuranQuery(targetQuery);

      if (!parsed.success) {
        logger.warn(server, `${u(user)} used /quran-play (failed: ${parsed.error})`);
        await interaction.reply({
          content: `❌ ${parsed.error}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const conn = await ensureConnectedToMember(interaction, server, user);
      if (!conn) return;

      await interaction.deferReply();

      const pb = getOrCreatePlayer(interaction.guild.id, server, conn.connection);
      pb.queue = [...parsed.target.items];
      pb.queueTitle = parsed.target.title;
      pb.currentTitle = parsed.target.title;

      logger.info(server, `Started playing ${parsed.target.title} (by ${u(user)})`);
      playNextInQueue(interaction.guild.id, server);

      await interaction.editReply(`▶️ Now playing **${parsed.target.title}** (Mishary Rashid Alafasy)`);
      return;
    }

    if (interaction.commandName === "tts") {
      const text = interaction.options.getString("text", true).trim();
      if (!text) {
        logger.warn(server, `${u(user)} used /tts (failed: empty text)`);
        await interaction.reply({
          content: "❌ Please provide some text to say out loud.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const conn = await ensureConnectedToMember(interaction, server, user);
      if (!conn) return;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const pb = getOrCreatePlayer(interaction.guild.id, server, conn.connection);
      const isIdle = pb.player.state.status === AudioPlayerStatus.Idle && !pb.loading;
      const title = `TTS: ${text.length > 60 ? `${text.slice(0, 57)}...` : text}`;
      const displayText = text.length > 1900 ? `${text.slice(0, 1897)}...` : text;
      const item: PlaybackItem = {
        title,
        getStream: () => createTtsStream(text),
      };

      pb.queue.push(item);

      if (isIdle) {
        pb.queueTitle = undefined;
        logger.info(server, `Speaking TTS "${text}" (by ${u(user)})`);
        playNextInQueue(interaction.guild.id, server);
        await interaction.editReply(`🗣️ ${displayText}`);
      } else {
        logger.info(server, `Queued TTS "${text}" (by ${u(user)})`);
        await interaction.editReply(`🗣️ Queued: ${displayText}`);
      }
      return;
    }

    if (
      interaction.commandName === "weather-today" ||
      interaction.commandName === "weather-week" ||
      interaction.commandName === "weather"
    ) {
      const conn = await ensureConnectedToMember(interaction, server, user);
      if (!conn) return;

      let timeframe: "today" | "week" = "today";
      if (interaction.commandName === "weather-week") {
        timeframe = "week";
      } else if (interaction.commandName === "weather") {
        const opt = interaction.options.getString("timeframe");
        if (opt === "week") timeframe = "week";
      }

      const locationQuery = interaction.options.getString("location") || undefined;
      const weatherResp = await getWeatherForecast(timeframe, locationQuery);

      if (!weatherResp.success) {
        logger.warn(server, `${u(user)} used /${interaction.commandName} (failed: ${weatherResp.error})`);
        await interaction.reply({
          content: `❌ ${weatherResp.error}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      await interaction.deferReply();

      const pb = getOrCreatePlayer(interaction.guild.id, server, conn.connection);
      pb.queue = [...weatherResp.result.items];
      pb.queueTitle = weatherResp.result.title;
      pb.currentTitle = weatherResp.result.title;

      logger.info(server, `Started playing ${weatherResp.result.title} (by ${u(user)})`);
      playNextInQueue(interaction.guild.id, server);

      await interaction.editReply(weatherResp.result.displayText);
      return;
    }

    if (interaction.commandName === "stop") {
      const pb = guildPlaybacks.get(interaction.guild.id);
      const connection = getVoiceConnection(interaction.guild.id);

      if (!connection || !pb || (pb.player.state.status === AudioPlayerStatus.Idle && pb.queue.length === 0 && !pb.loading)) {
        logger.warn(server, `${u(user)} used /stop (failed: not playing)`);
        await interaction.reply({
          content: "No audio is currently playing.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const stoppedTitle = pb.currentTitle;
      stopPlayback(pb);

      logger.info(server, `Playback stopped (by ${u(user)})`);
      await interaction.reply({
        content: `⏹️ Stopped playback${stoppedTitle ? ` of **${stoppedTitle}**` : ""}.`,
      });
      return;
    }

    if (interaction.commandName === "dismiss" || interaction.commandName === "disconnect") {
      const connection = getVoiceConnection(interaction.guild.id);

      if (!connection) {
        logger.warn(server, `${u(user)} used /dismiss (failed: bot not connected)`);
        await interaction.reply({
          content: "I am not in a voice channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const member = interaction.member as GuildMember;
      if (member?.voice?.channelId && member.voice.channelId !== connection.joinConfig.channelId) {
        logger.warn(server, `${u(user)} used /dismiss (failed: bot in different channel)`);
        await interaction.reply({
          content: "You are not in the same voice channel as the bot.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      cleanupGuildPlayback(interaction.guild.id);

      connection.destroy();
      logger.info(server, `Dismissed from voice (by ${u(user)})`);
      await interaction.reply("Dismissed from the voice channel.");
      return;
    }
  } catch (err: any) {
    logger.error(server, `Command /${interaction.commandName} error: ${err.message}`);
    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({
            content: "An unexpected error occurred while executing this command.",
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: "An unexpected error occurred while executing this command.",
            flags: MessageFlags.Ephemeral,
          });
        }
      } catch {
        // Network socket failed; suppress further cascading errors
      }
    }
  }
});

process.on("unhandledRejection", (err: any) => {
  logger.error("System", `Unhandled rejection: ${err?.message || err}`);
});

process.on("uncaughtException", (err: any) => {
  logger.error("System", `Uncaught exception: ${err?.message || err}`);
});

client.login(process.env.DISCORD_TOKEN).catch((err: any) => {
  logger.error("System", `Login failed: ${err.message}`);
});

# AGENTS.md

Project conventions and non-obvious constraints for `velle-discord-bot`.

## Runtime, Dependencies & Deployment

- **No build step or test suite**: TypeScript runs directly via `npm start` (`node --import tsx index.ts`), with no `tsconfig.json` and no tests (`npm test` exits 1). Requires `DISCORD_TOKEN` in `.env` (loaded via `dotenv/config`).
- **Keep `package-lock.json` in sync**: Production installs with `npm ci`. Any dependency change in `package.json` must include an updated `package-lock.json`.
- **Pushing to `main` auto-deploys to production**: [.github/workflows/deploy.yml](.github/workflows/deploy.yml) SSHs to the VPS on every push to `main` and restarts the `velle-bot` systemd service via a forced SSH command (`sudo /usr/local/bin/deploy-velle-bot`).
- **`scripts/deploy.sh` is a reference copy**: The live deploy script is `/usr/local/bin/deploy-velle-bot` on the server; editing `scripts/deploy.sh` alone does not update production deploys.
- **IPv4-first DNS**: `dns.setDefaultResultOrder("ipv4first")` is intentionally set in `index.ts` and `weather.ts` for reliable voice/external HTTP/TTS connections; keep this for network entrypoints.

## Discord Command & Interaction Conventions

- **Guild-scoped command registration**: Commands are registered per guild via `guild.commands.set(commands)` on `clientReady` and `guildCreate`, not globally.
- **No admin/permission gating**: Do not add `.setDefaultMemberPermissions(...)` or admin-only checks to slash commands; all commands are intentionally usable by any member in voice.
- **Ephemeral failures & `/tts`**:
  - Precondition failures (not in voice, bot in another channel, invalid input/query, empty `/tts` text) and `/tts` responses must use `flags: MessageFlags.Ephemeral`.
  - If an interaction was already deferred non-ephemerally and then fails (see `ensureConnectedToMember` in `index.ts`), delete the deferred reply first (`await interaction.deleteReply().catch(() => {})`) and send an ephemeral `followUp` — Discord cannot convert a deferred public reply to ephemeral.
- **Voice connection guard & restart persistence**:
  - Playback commands (`/quran-play`, `/weather*`, `/tts`) must resolve the connection via `ensureConnectedToMember(interaction, server, user)`, which joins the user's channel if disconnected or rejects if the bot is already in another channel.
  - Joining voice must go through `connectToVoiceChannel`, which persists `{ [guildId]: channelId }` in gitignored `.voice-state.json` (cleared only on `/dismiss`, `guildDelete`, or permanent `Disconnected` drops). On `clientReady`, `rejoinSavedVoiceChannels` takes over the live ghost state (`guild.members.me?.voice.channelId`) or falls back to `.voice-state.json`.
  - **Do not add a `SIGTERM`/`SIGINT` handler that calls `connection.destroy()` or `client.destroy()`**: abrupt exit on systemd restart intentionally keeps Discord's ghost voice state alive for a few seconds so an empty voice call/streak does not end before the restarted process takes over.

## Audio Playback & Queue Conventions

- **Per-guild state & race guard**: Guild state lives in `guildPlaybacks` (`Map<string, GuildPlayback>`). Every async item load in `playNextInQueue` captures `++pb.playbackId` and checks `currentPb.playbackId !== currentPlaybackId` before playing or advancing; preserve this check in any async playback path.
- **Stopping playback**: Always stop/reset via `stopPlayback(pb)` (increments `playbackId`, clears `queue`, `loading`, `queueTitle`, `currentTitle`, and calls `pb.player.stop(true)`).
- **Queue item shape**: Items must provide `{ title, url }` (for remote MP3s via `createAudioResourceFromUrl`, which sends a browser `User-Agent`) or `{ title, getStream }` (for lazy TTS streams via `createTtsStream` using `en-US-ChristopherNeural` so audio is synthesized just-in-time rather than upfront).
- **Replace vs. append semantics**:
  - Content commands (`/quran-play`, `/weather*`) replace `pb.queue` and set `pb.queueTitle` to the overall title.
  - Short spoken items (`/tts`, `voiceStateUpdate` join/leave announcements) push onto `pb.queue` and only start playback (clearing `pb.queueTitle = undefined`) when `pb.player.state.status === AudioPlayerStatus.Idle && !pb.loading`.

## Logging

- Use `logger.info(context, message)`, `logger.warn(...)`, and `logger.error(...)` instead of raw `console.log`, formatting usernames with `u(username)` (`@username`).
- Context conventions: guild name (`server`) for commands/voice activity, `"System"` for startup and process-level errors, `"Discord"` for client errors/warnings, `"Voice"` for `voiceStateUpdate` catch errors.

## Domain Invariants

- **Quran (`quran.ts`)**: `parseQuranQuery` prepends Bismillah (`001001.mp3`) when ayah `1` is requested as a single ayah or range start, **except** for Surah 1 (`Al-Fatihah`, where Bismillah is 1:1) and Surah 9 (`At-Tawbah`).
- **Weather (`weather.ts`)**: When `location` is omitted, forecasts default to **both** Dhaka and Rangpur in that order (using Open-Meteo with no API key).

import type { PluginContext, TInvokerContext } from "@sharkord/plugin-sdk";
import Fuse from "fuse.js";
import { parse, type Playlist, type PlaylistItem } from "iptv-playlist-parser";
import { killFFmpegProcesses, spawnFFmpeg, type TProcessPair } from "./ffmpeg";
import {
  zPlayStreamCommand,
  zStartStreamCommand,
  type TPlayStreamCommand,
  type TStartStreamCommand,
} from "./types";

type TStreamState = {
  processes: TProcessPair;
  intervalId: ReturnType<typeof setInterval> | null;
  streamActive: boolean;
  streamStarting: boolean;
  videoProducer: any;
  audioProducer: any;
  videoTransport: any;
  audioTransport: any;
  streamHandle: any;
  isCleaning: boolean;
};

const streamStates = new Map<number, TStreamState>();

const getStreamState = (channelId: number): TStreamState => {
  const existing = streamStates.get(channelId);

  if (existing) return existing;

  const state: TStreamState = {
    processes: {},
    intervalId: null,
    streamActive: false,
    streamStarting: false,
    videoProducer: null,
    audioProducer: null,
    videoTransport: null,
    audioTransport: null,
    streamHandle: null,
    isCleaning: false,
  };

  streamStates.set(channelId, state);

  return state;
};

const cleanupChannel = (channelId: number) => {
  const state = streamStates.get(channelId);

  if (!state) return;
  if (state.isCleaning) return;

  state.isCleaning = true;

  try {
    killFFmpegProcesses(state.processes);

    state.processes = {};

    state.streamHandle?.close?.();
    state.streamHandle = null;

    state.videoProducer?.close();
    state.audioProducer?.close();
    state.videoTransport?.close();
    state.audioTransport?.close();

    state.videoProducer = null;
    state.audioProducer = null;
    state.videoTransport = null;
    state.audioTransport = null;

    if (state.intervalId) {
      clearInterval(state.intervalId);

      state.intervalId = null;
    }

    state.streamActive = false;
    state.streamStarting = false;
  } finally {
    state.isCleaning = false;

    streamStates.delete(channelId);
  }
};

const cleanupAll = () => {
  for (const channelId of streamStates.keys()) {
    cleanupChannel(channelId);
  }
};

type PlaylistCache = {
  raw: string;
  parsed: Playlist | null;
  fuse: Fuse<PlaylistItem> | null;
  error: string | null;
};

const playlistCache: PlaylistCache = {
  raw: "",
  parsed: null,
  fuse: null,
  error: null,
};

const createPlaylistFuse = (items: PlaylistItem[]) =>
  new Fuse(items, {
    keys: [
      { name: "name", weight: 0.7 },
      { name: "tvg.name", weight: 0.2 },
      { name: "group.title", weight: 0.1 },
    ],
    includeScore: true,
    threshold: 0.4,
    ignoreLocation: true,
    minMatchCharLength: 2,
  });

const loadPlaylist = (rawPlaylist: string): Playlist => {
  if (rawPlaylist !== playlistCache.raw) {
    playlistCache.raw = rawPlaylist;

    try {
      playlistCache.parsed = parse(rawPlaylist);
      playlistCache.fuse = createPlaylistFuse(playlistCache.parsed.items);
      playlistCache.error = null;
    } catch (error) {
      playlistCache.parsed = null;
      playlistCache.fuse = null;
      playlistCache.error =
        error instanceof Error ? error.message : String(error);
    }
  }

  if (!playlistCache.parsed) {
    throw new Error(
      playlistCache.error || "Playlist could not be parsed. Check settings.",
    );
  }

  return playlistCache.parsed;
};

const findClosestChannel = (query: string): PlaylistItem | null => {
  if (!playlistCache.parsed || !playlistCache.fuse) return null;

  const results = playlistCache.fuse.search(query, { limit: 1 });

  return results[0]?.item ?? null;
};

const startStream = async (
  ctx: PluginContext,
  invoker: TInvokerContext,
  sourceUrl: string,
  streamName?: string,
  streamImageUrl?: string,
) => {
  if (invoker.currentVoiceChannelId === undefined) {
    throw new Error("You must be in a voice channel to start a stream.");
  }

  const channelId = invoker.currentVoiceChannelId;
  const state = getStreamState(channelId);

  if (state.streamActive) {
    throw new Error(
      "A stream is already active. Stop it before starting a new one.",
    );
  }

  if (state.streamStarting) {
    throw new Error("A stream is already starting. Please wait.");
  }

  ctx.log("Voice runtime initialized in IPTV plugin");

  const router = ctx.actions.voice.getRouter(channelId);

  if (!router) {
    ctx.log("No router found for channel:", channelId);
    return;
  }

  state.streamStarting = true;

  try {
    const { announcedAddress, ip } = await ctx.actions.voice.getListenInfo();

    ctx.log("Listen Info:", { announcedAddress, ip });

    addOnceListener(router, "@close", () => {
      ctx.log("Router closed, cleaning up");
      cleanupChannel(channelId);
    });

    const ssrc = 11111111;
    const audioSsrc = 22222222;

    state.videoTransport = await router.createPlainTransport({
      listenInfo: {
        ip,
        protocol: "udp",
        announcedAddress: announcedAddress,
      },
      rtcpMux: false,
      comedia: true,
      enableSrtp: false,
    });

    state.audioTransport = await router.createPlainTransport({
      listenIp: {
        ip,
        announcedIp: announcedAddress,
      },
      rtcpMux: true,
      comedia: true,
      enableSrtp: false,
    });

    ctx.log("Video RTP ingest on port", state.videoTransport.tuple.localPort);
    ctx.log("Audio RTP ingest on port", state.audioTransport.tuple.localPort);

    state.videoProducer = await state.videoTransport.produce({
      kind: "video",
      rtpParameters: {
        codecs: [
          {
            mimeType: "video/H264",
            payloadType: 102,
            clockRate: 90000,
            parameters: {
              "packetization-mode": 1,
              "profile-level-id": "42e01f",
              "level-asymmetry-allowed": 1,
              "x-google-start-bitrate": 1000,
            },
            rtcpFeedback: [],
          },
        ],
        encodings: [{ ssrc: ssrc }],
      },
    });

    state.audioProducer = await state.audioTransport.produce({
      kind: "audio",
      rtpParameters: {
        codecs: [
          {
            mimeType: "audio/opus",
            payloadType: 111,
            clockRate: 48000,
            channels: 2,
            parameters: {},
            rtcpFeedback: [],
          },
        ],
        encodings: [{ ssrc: audioSsrc }],
      },
    });

    state.streamHandle = ctx.actions.voice.createStream({
      key: "stream",
      channelId: channelId,
      title: streamName ?? "IPTV",
      avatarUrl: streamImageUrl ?? "https://i.imgur.com/ozINkq3.jpeg",
      producers: {
        video: state.videoProducer,
        audio: state.audioProducer,
      },
    });

    const videoProducer = state.videoProducer;
    const audioProducer = state.audioProducer;

    addOnceListener(videoProducer?.observer, "close", () => {
      ctx.log("IPTV video producer closed:", videoProducer.id);
      cleanupChannel(channelId);
    });

    addOnceListener(audioProducer?.observer, "close", () => {
      ctx.log("IPTV audio producer closed:", audioProducer.id);
      cleanupChannel(channelId);
    });

    try {
      state.processes = await spawnFFmpeg(ctx.path, {
        sourceUrl,
        gopSize: 30,
        videoPayloadType: 102,
        audioPayloadType: 111,
        videoSsrc: ssrc,
        audioSsrc: audioSsrc,
        rtpHost: ip,
        videoRtpPort: state.videoTransport.tuple.localPort,
        audioRtpPort: state.audioTransport.tuple.localPort,
        packetSize: 1200,
        log: (...messages: unknown[]) => {
          ctx.debug("[FFmpeg]", ...messages);
        },
        error: (...messages: unknown[]) => {
          ctx.error("[FFmpeg]", ...messages);
        },
      });
    } catch (error) {
      cleanupChannel(channelId);

      throw error;
    }

    state.streamActive = true;
  } finally {
    const state = streamStates.get(channelId);

    if (state) {
      state.streamStarting = false;
    }
  }
};

const addOnceListener = (target: any, event: string, handler: () => void) => {
  if (!target) return;

  if (typeof target.once === "function") {
    target.once(event, handler);
    return;
  }

  if (typeof target.on === "function") {
    target.on(event, handler);
  }
};

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register([
    {
      key: "playlist",
      name: "Playlist URL",
      description: "The contents of the playlist .m3u file",
      type: "string",
      defaultValue: "",
    },
  ]);

  ctx.commands.register<TStartStreamCommand>({
    name: "iptv_play_direct",
    description:
      "Start an IPTV stream in the specified channel from a direct URL",
    args: [
      {
        name: "sourceUrl",
        description:
          "The source URL of the stream. Note that this must be a direct link to a media stream, not a playlist.",
        type: "string",
        required: true,
        sensitive: true,
      },
      {
        name: "streamName",
        description: "The name of the stream",
        type: "string",
        required: false,
      },
    ],
    executes: async (invoker, input) => {
      console.log(JSON.stringify({ invoker, input }, null, 2));

      const { sourceUrl, streamName } = zStartStreamCommand.parse(input);

      await startStream(ctx, invoker, sourceUrl, streamName);
    },
  });

  ctx.commands.register<TPlayStreamCommand>({
    name: "iptv_play",
    description:
      "Start an IPTV stream in the specified channel from the playlist",
    args: [
      {
        name: "channelName",
        description: "The name of the channel to play",
        type: "string",
        required: true,
      },
    ],
    executes: async (invoker, input) => {
      console.log(JSON.stringify({ invoker, input }, null, 2));

      const { channelName } = zPlayStreamCommand.parse(input);
      const rawPlaylist = settings.get("playlist").trim();

      if (!rawPlaylist) {
        throw new Error("Playlist is empty. Add it in plugin settings.");
      }

      loadPlaylist(rawPlaylist);
      const item = findClosestChannel(channelName);

      ctx.log('Found channel match for "', channelName, '":', item?.name);

      if (!item?.url) {
        throw new Error(
          `No channel match found for "${channelName}" in the playlist.`,
        );
      }

      const displayName = item.name || item.tvg?.name || channelName;

      await startStream(ctx, invoker, item.url, displayName, item.tvg?.logo);
    },
  });

  ctx.commands.register({
    name: "iptv_stop",
    description: "Stop the IPTV stream in the specified channel",
    executes: async (invoker) => {
      if (invoker.currentVoiceChannelId === undefined) {
        throw new Error("You must be in a voice channel to stop a stream.");
      }

      const channelId = invoker.currentVoiceChannelId;
      const state = streamStates.get(channelId);

      if (!state || !state.streamActive) {
        ctx.log("No active stream to stop in this channel.");
        return;
      }

      ctx.log("Stopping IPTV stream");

      cleanupChannel(channelId);

      ctx.log("IPTV stream stopped");
    },
  });

  ctx.commands.register({
    name: "iptv_clean",
    description: "Forcefully cleans up the active stream in this channel",
    executes: async (invoker) => {
      if (invoker.currentVoiceChannelId === undefined) {
        throw new Error("You must be in a voice channel to clean a stream.");
      }

      cleanupChannel(invoker.currentVoiceChannelId);
    },
  });

  ctx.commands.register({
    name: "iptv_cleanall",
    description: "Forcefully cleans up all active streams and processes",
    executes: async () => {
      cleanupAll();
    },
  });
};

const onUnload = (ctx: PluginContext) => {
  cleanupAll();

  ctx.log("IPTV Plugin unloaded");
};

export { onLoad, onUnload };

import path from "path";
import fs from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";

// a lot of vibes going on this file
// i don't even know if this is efficient or the best way to do this, but it's kinda working

type TOptions = {
  sourceUrl: string;
  gopSize: number;
  videoPayloadType: number;
  audioPayloadType: number;
  videoSsrc: number;
  audioSsrc: number;
  rtpHost: string;
  videoRtpPort: number;
  audioRtpPort: number;
  packetSize: number;
  log: (...messages: unknown[]) => void;
  error: (...messages: unknown[]) => void;
};

type TProcessPair = {
  hls?: ReturnType<typeof Bun.spawn>;
  videoRtp?: ReturnType<typeof Bun.spawn> | null;
  audioRtp?: ReturnType<typeof Bun.spawn> | null;
};

const __dirname = dirname(fileURLToPath(import.meta.url));

const getBinaryPath = (): string => {
  let binaryName = "ffmpeg.exe";

  if (process.platform !== "win32") {
    binaryName = "ffmpeg";
  }

  return path.join(__dirname, "bin", binaryName);
};

const spawnFFmpeg = async (
  pluginPath: string,
  options: TOptions,
): Promise<TProcessPair> => {
  const binaryPath = getBinaryPath();

  options.log(`Binary path: ${binaryPath}`);

  const hlsDir = path.join(pluginPath, "hls");
  const hlsPlaylist = path.join(hlsDir, "stream.m3u8");

  if (fs.existsSync(hlsDir)) {
    const files = fs.readdirSync(hlsDir);

    files.forEach((file) => {
      fs.unlinkSync(path.join(hlsDir, file));
    });
  } else {
    fs.mkdirSync(hlsDir, { recursive: true });
  }

  // create HLS buffer from IPTV
  const hlsArgs = [
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "5",
    "-timeout",
    "10000000",
    "-user_agent",
    "Mozilla/5.0",

    "-fflags",
    "+genpts+discardcorrupt",
    "-err_detect",
    "ignore_err",

    "-i",
    options.sourceUrl,

    // deinterlace here to avoid doing it twice
    "-vf",
    "yadif=1:-1:0",

    // transcode to H264 baseline here (do it once)
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-profile:v",
    "baseline",
    "-level",
    "3.1",
    "-pix_fmt",
    "yuv420p",

    // moderate bitrate
    "-b:v",
    "2500k",
    "-maxrate",
    "3000k",
    "-bufsize",
    "6000k",

    "-g",
    "50",
    "-sc_threshold",
    "0",
    "-r",
    "25",

    // audio: convert to opus
    "-c:a",
    "libopus",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "128k",

    // hls output with bigger buffer
    "-f",
    "hls",
    "-hls_time",
    "2", // 2 second segments
    "-hls_list_size",
    "15", // keep 15 segments (30 seconds buffer)
    "-hls_flags",
    "delete_segments+append_list",
    "-hls_segment_type",
    "mpegts",
    "-hls_segment_filename",
    path.join(hlsDir, "segment_%03d.ts"),
    "-start_number",
    "0",

    hlsPlaylist,
  ];

  options.log("Starting HLS buffer creation...");

  const hlsProcess = Bun.spawn({
    cmd: [binaryPath, ...hlsArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  (async () => {
    const reader = hlsProcess.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[HLS stdout]", text.trim());
      }
    } catch (error) {
      options.error("[HLS stdout error]", error);
    }
  })();

  // Handle HLS stderr
  (async () => {
    const reader = hlsProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[HLS stderr]", text.trim());
      }
    } catch (error) {
      options.error("[HLS stderr error]", error);
    }
  })();

  options.log("Waiting for HLS playlist...");

  await waitForHLS(hlsPlaylist, 4); // wait for 4 segments (8 seconds)

  options.log("HLS playlist ready with buffer!");

  // stream VIDEO from hls to rtp
  const videoRtpArgs = [
    "-re",
    "-stream_loop",
    "-1",

    "-i",
    hlsPlaylist,

    "-map",
    "0:v:0",
    "-an",

    // just copy video - no transcoding needed
    "-c:v",
    "copy",

    "-payload_type",
    options.videoPayloadType.toString(),
    "-ssrc",
    options.videoSsrc.toString(),
    "-f",
    "rtp",
    `rtp://${options.rtpHost}:${options.videoRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting video RTP stream from HLS...");

  const videoRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...videoRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  // stream AUDIO from hls to rtp
  const audioRtpArgs = [
    "-re",
    "-stream_loop",
    "-1",

    "-i",
    hlsPlaylist,

    "-map",
    "0:a:0",
    "-vn",

    // just copy audio - already opus
    "-c:a",
    "copy",

    "-payload_type",
    options.audioPayloadType.toString(),
    "-ssrc",
    options.audioSsrc.toString(),
    "-f",
    "rtp",
    `rtp://${options.rtpHost}:${options.audioRtpPort}?pkt_size=1200`,
  ];

  options.log("Starting audio RTP stream from HLS...");

  const audioRtpProcess = Bun.spawn({
    cmd: [binaryPath, ...audioRtpArgs],
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  (async () => {
    const reader = videoRtpProcess.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Video RTP stdout]", text.trim());
      }
    } catch (error) {
      options.error("[Video RTP stdout error]", error);
    }
  })();

  (async () => {
    const reader = videoRtpProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Video RTP stderr]", text.trim());
      }
    } catch (error) {
      options.error("[Video RTP stderr error]", error);
    }
  })();

  (async () => {
    const reader = audioRtpProcess.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Audio RTP stdout]", text.trim());
      }
    } catch (error) {
      options.error("[Audio RTP stdout error]", error);
    }
  })();

  (async () => {
    const reader = audioRtpProcess.stderr.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        const text = decoder.decode(value, { stream: true });

        options.log("[Audio RTP stderr]", text.trim());
      }
    } catch (error) {
      options.error("[Audio RTP stderr error]", error);
    }
  })();

  return {
    hls: hlsProcess,
    videoRtp: videoRtpProcess,
    audioRtp: audioRtpProcess,
  };
};

const waitForHLS = async (
  playlistPath: string,
  minSegments: number = 4,
  timeout: number = 30000,
): Promise<void> => {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    if (fs.existsSync(playlistPath)) {
      const content = fs.readFileSync(playlistPath, "utf8");
      const segmentCount = (content.match(/\.ts/g) || []).length;

      if (segmentCount >= minSegments) {
        await Bun.sleep(2000);

        return;
      }
    }

    await Bun.sleep(500);
  }

  throw new Error("HLS playlist not created within timeout");
};

const killFFmpegProcesses = (processes: TProcessPair): void => {
  if (processes.videoRtp) {
    processes.videoRtp.kill();
  }

  if (processes.audioRtp) {
    processes.audioRtp.kill();
  }

  if (processes.hls) {
    processes.hls.kill();
  }
};

export { spawnFFmpeg, killFFmpegProcesses };
export type { TOptions, TProcessPair };

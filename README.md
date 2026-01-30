# sharkord-iptv

Simple IPTV Plugin for Sharkord. Allows you to stream IPTV channels (and others) directly within Sharkord.

## Installation

1. Download the latest release from the [Releases](https://github.com/yourusername/sharkord-iptv/releases) page.
2. Move the `sharkord-iptv` folder to your Sharkord plugins directory, typically located at `~/.config/sharkord/plugins`.
3. Download and place the ffmpeg binary (`ffmpeg`for UNIX and `ffmpeg.exe`for Windows) in the `bin` folder inside the `sharkord-iptv` plugin directory. For the best results, use the latest version of ffmpeg.
4. Make sure the ffmpeg binary has execution permissions (on UNIX systems, you can run `chmod +x ./ffmpeg` in the terminal).
5. Open Sharkord and enable the plugin.

## Screenshots

![ss](https://i.imgur.com/IGmWnqC.png)

## Commands

- `/iptv_start <stream_url>`: Starts streaming the specified IPTV stream in the given channel. This NEEDS to be a direct stream URL (e.g., an m3u8 link) NOT a playlist.
- `/iptv_stop`: Stops the currently active IPTV stream in the channel.
- `/iptv_clean`: Forcefully cleans up any active streams and processes.

## Notes

The ffmpeg implementation is really basic and might not work perfectly all the time. Probably I'll improve it in the future. I'll also add playlist support and other features as soon as Sharkord has a better plugin API.

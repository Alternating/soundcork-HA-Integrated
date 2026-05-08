# SoundCork + Home Assistant Integration

A patched version of [SoundCork](https://github.com/timvw/soundcork) with full Home Assistant integration, enabling control of Bose SoundTouch speakers after the Bose cloud shutdown.

## What This Adds

**SoundCork Patches (`docker/main.py`)**
- `serviceAvailability` stub endpoints to keep speakers online
- REST API endpoints for Home Assistant integration (`/api/v1/speakers/*`)
- TuneIn podcast search support (`include=podcasts`)
- Podcast show ID resolution — automatically plays latest episode
- Pre-resolves redirect chains so SoundTouch hardware can stream podcasts

**SoundCork Web UI (`docker/app.js`)**
- Podcast results shown alongside stations in TuneIn search
- Podcast badge indicator in search results

**Home Assistant Custom Integration (`custom_components/soundcork/`)**
- Native HA integration with config flow
- One `media_player` entity per speaker
- Polls now-playing, volume, and presets every 10 seconds
- Services: `play_preset`, `store_preset_tunein`, `store_preset_radio`

**Lovelace Card (`lovelace/soundcork-preset-editor.js`)**
- `mode: player` — dynamic preset grid with artwork, plays all speakers
- `mode: speaker` — individual speaker card with artwork, volume, power
- `mode: editor` — TuneIn search supporting stations and podcasts

## Requirements

- Docker (tested on Proxmox LXC)
- Home Assistant with HACS
- Bose SoundTouch speakers on local network

## Setup

### 1. Deploy SoundCork Docker Container

```bash
docker build -t soundcork-local:latest ./docker

docker run -d \
  --name soundcork \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /soundcork/data:/soundcork/data \
  -e base_url=http://YOUR_SERVER_IP:8000 \
  -e data_dir=/soundcork/data \
  -e MGMT_PASSWORD=your_password \
  soundcork-local:latest
```

### 2. Point Speakers at SoundCork

Each Bose SoundTouch speaker must have its DNS overridden to point `*.bose.com` and `*.bosetm.com` to your SoundCork server IP. Configure this in your router/DNS server.

### 3. Install Home Assistant Integration

Copy `custom_components/soundcork/` to your HA `/config/custom_components/` directory, then restart HA and add the integration via Settings → Integrations → Add → SoundCork.

### 4. Install Lovelace Card

Copy `lovelace/soundcork-preset-editor.js` to `/config/www/` on your HA server and register it as a dashboard resource.

## Dashboard Card Configuration

```yaml
# Preset player (all speakers)
type: custom:soundcork-preset-editor
soundcork_url: http://YOUR_SERVER_IP:8000
mode: player
speakers:
  - media_player.your_speaker_1
  - media_player.your_speaker_2

# Individual speaker card
type: custom:soundcork-preset-editor
soundcork_url: http://YOUR_SERVER_IP:8000
mode: speaker
speaker_name: Living Room
speakers:
  - media_player.living_room

# TuneIn preset editor
type: custom:soundcork-preset-editor
soundcork_url: http://YOUR_SERVER_IP:8000
mode: editor
speakers:
  - media_player.your_speaker_1
```

## Credits

Built on top of [SoundCork](https://github.com/timvw/soundcork) by timvw.

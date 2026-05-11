# SoundCork + Home Assistant — Complete Setup Guide

This guide walks through setting up a single Bose SoundTouch speaker with SoundCork and Home Assistant from scratch. Once one speaker is working, adding additional speakers follows the same pattern using a shortcut command.

---

## Overview

When Bose shut down their cloud servers, SoundTouch speakers lost the ability to use TuneIn radio and most features. SoundCork replaces the Bose cloud on your local network. This project extends SoundCork with:
- A Home Assistant integration for native media_player entities
- A custom Lovelace dashboard card with preset management
- Podcast support (TuneIn podcasts resolve to the latest episode automatically)
- Zone sync so all speakers play in perfect sync

**Goal:** After following this guide, you will have one speaker fully working with SoundCork and controllable from Home Assistant. The final section covers adding additional speakers efficiently.

---

## What You Need

- A Linux server, VM, or LXC container with Docker installed (this guide uses Proxmox LXC)
- A Bose SoundTouch speaker on your local network (any model)
- Home Assistant running on your network
- A USB flash drive (to enable SSH on the speaker — one time only)
- Basic familiarity with the Linux command line

---

## Part 1: Enable SSH on Your Bose Speaker

Bose speakers run Linux internally but SSH is disabled by default. You enable it once using a USB stick.

### 1.1 Create the SSH unlock file

On Windows, open PowerShell:
```powershell
# Insert your USB drive first, then replace E: with your drive letter
New-Item -Path "E:\remote_services" -ItemType File
```

On Mac/Linux:
```bash
touch /Volumes/USBDRIVE/remote_services
```

This creates a file called `remote_services` with no extension. The speaker's firmware looks for this file on boot.

### 1.2 Unlock the speaker

1. Power off the speaker completely
2. Insert the USB drive into the speaker's USB port
3. Power the speaker back on
4. Wait 60 seconds for it to boot fully
5. Remove the USB drive

### 1.3 Find the speaker's IP address

Check your router's DHCP table, or scan your network:
```bash
# From any Linux machine on your network
nmap -sn 192.168.1.0/24 | grep -B2 "Bose"
```

### 1.4 Test SSH access

The speaker uses older SSH key types. You must include these flags every time:

```bash
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa root@192.168.1.228
```

Replace `192.168.1.228` with your speaker's IP. No password is required — it logs in directly. If you see a `root@rhino:~#` prompt, SSH is working.

### 1.5 Make the filesystem writable

The speaker's filesystem is read-only by default. Once logged in via SSH, you must run this command before you can write any files:

```bash
rw
```

You will need to run `rw` at the start of every SSH session where you intend to write files. Without it, any write commands will fail with `Read-only file system`.

### 1.6 Make SSH persistent (important — do this now)

By default, SSH access is only enabled when the USB stick is present on boot. To make SSH available permanently without needing the USB stick again, run this while logged in:

```bash
rw
touch /mnt/nv/remote_services
```

This creates a permanent file on the speaker's internal storage that keeps SSH enabled across reboots. Without this step, you would need to repeat the USB stick process every time the speaker loses power.

> **Verify it worked:** Reboot the speaker and SSH back in without the USB stick. If it connects, the persistent SSH is confirmed.

### 1.7 Basic vi commands for editing on the speaker

When you need to edit files directly on the speaker, the only available editor is `vi`. Here are the essential commands:

| Action | Command |
|---|---|
| Open a file | `vi /path/to/file` |
| Enter edit mode | Press `i` (you'll see `-- INSERT --` at the bottom) |
| Exit edit mode | Press `Esc` |
| Save and quit | Type `:wq` then press `Enter` |
| Quit without saving | Type `:q!` then press `Enter` |
| Force save read-only file | Type `:w!` then press `Enter` |
| Delete current line | Press `Esc` then type `dd` |
| Move to beginning of file | Press `Esc` then type `gg` |

> **Tip:** Always press `Esc` first to make sure you are out of insert mode before typing any `:` commands. A common mistake is trying to type `:wq` while still in insert mode — it will just type those characters into the file instead of saving.

> **Note:** The hostname `rhino` is the internal Bose codename for SoundTouch hardware. This is normal.

---

## Part 2: Set Up the Docker Server

SoundCork runs as a Docker container. This guide uses a Proxmox LXC container but any Linux machine with Docker works.

### 2.1 Create a Proxmox LXC container (skip if using existing server)

In the Proxmox shell, run the community Docker helper:
```bash
bash -c "$(wget -qLO - https://github.com/community-scripts/ProxmoxVE/raw/main/ct/docker.sh)"
```

When prompted, choose:
- Default settings for everything
- Answer `n` to Portainer, Portainer Agent, and Docker TCP socket
- Note the assigned IP address (e.g., `192.168.1.229`)

> **Important:** Assign a **static IP** to this container. The speaker configuration will point to this IP permanently. If the IP changes, all speakers will stop working.

### 2.2 Verify Docker is running

```bash
docker --version
docker ps
```

---

## Part 3: Build the Custom SoundCork Image

This repository contains a patched version of SoundCork with podcast support, Home Assistant API endpoints, and zone sync. You must build from this repo rather than using the original image.

### 3.1 Clone the repository

```bash
cd /
git clone https://github.com/Alternating/soundcork-HA-Integrated soundcork
cd /soundcork
```

### 3.2 Review the Dockerfile

```bash
cat /soundcork/docker/Dockerfile
```

You should see:
```dockerfile
FROM ghcr.io/timvw/soundcork:main
COPY main.py /app/soundcork/main.py

```

This takes the base SoundCork image and replaces two files with our patched versions.

### 3.3 Build the image

```bash
cd /soundcork/docker
docker build -t soundcork-local:latest .
```

A successful build ends with:
```
=> naming to docker.io/library/soundcork-local:latest
```

---

## Part 4: Collect Files From Your Speaker

SoundCork needs four data files from your speaker to function. These contain your account ID, device ID, presets, and source configuration.

### 4.1 Get your speaker's device information

From your Docker server, run:
```bash
curl http://192.168.1.228:8090/info
```

This returns XML like:
```xml
<info deviceID="A0F6FD743B41">
  <name>The Deck</name>
  <margeAccountUUID>4365315</margeAccountUUID>
  ...
</info>
```

Write down two values — you'll use them to create the correct folder structure:
- `deviceID` — e.g., `A0F6FD743B41`
- `margeAccountUUID` — e.g., `4365315`

### 4.2 Create the data directory structure

SoundCork expects a specific folder layout. Replace `4365315` and `A0F6FD743B41` with your values:

```bash
mkdir -p /soundcork/data/4365315/devices/A0F6FD743B41
```

The full structure will look like:
```
/soundcork/data/
├── 4365315/                          ← your Bose account ID
│   ├── devices/
│   │   └── A0F6FD743B41/            ← your speaker's device ID
│   │       └── DeviceInfo.xml
│   ├── Presets.xml
│   ├── Recents.xml
│   └── Sources.xml
└── webui_speakers.json
```

### 4.3 Fetch files from the speaker API

These three files can be fetched directly over HTTP — no SSH needed:

```bash
SPEAKER_IP="192.168.1.228"
ACCOUNT_ID="4365315"
DEVICE_ID="A0F6FD743B41"

# Device info
curl http://$SPEAKER_IP:8090/info \
  > /soundcork/data/$ACCOUNT_ID/devices/$DEVICE_ID/DeviceInfo.xml

# Presets (your saved preset slots 1-6)
curl http://$SPEAKER_IP:8090/presets \
  > /soundcork/data/$ACCOUNT_ID/Presets.xml

# Recently played
curl http://$SPEAKER_IP:8090/recents \
  > /soundcork/data/$ACCOUNT_ID/Recents.xml
```

### 4.4 Fetch Sources.xml via SSH

Sources.xml is only available via SSH from the speaker's internal filesystem:

```bash
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@192.168.1.228 \
  "cat /mnt/nv/BoseApp-Persistence/1/Sources.xml" \
  > /soundcork/data/4365315/Sources.xml
```

### 4.5 Verify the files are clean XML

Each file should start with `<?xml`. Run:
```bash
head -1 /soundcork/data/4365315/devices/A0F6FD743B41/DeviceInfo.xml
head -1 /soundcork/data/4365315/Presets.xml
head -1 /soundcork/data/4365315/Sources.xml
```

If any file starts with `??` or `StatusCode`, it was captured incorrectly with a Windows tool and has encoding issues. Re-fetch it using the Linux `curl` or `ssh` commands above.

### 4.6 Set correct file permissions

SoundCork runs as user ID 1000 inside the container. The data directory must be owned by that user:

```bash
chown -R 1000:1000 /soundcork/data
chmod -R 755 /soundcork/data
```

> **Important:** Run this command any time you add new files to `/soundcork/data` from outside the container, or SoundCork will fail to read them.

### 4.7 Create the speakers registry file

This tells SoundCork's web UI about your speaker:

```bash
cat > /soundcork/data/webui_speakers.json << EOF
[
  {
    "id": "A0F6FD743B41",
    "name": "The Deck",
    "emoji": "🔊",
    "ipAddress": "192.168.1.228",
    "type": "SoundTouch 10",
    "deviceId": "A0F6FD743B41"
  }
]
EOF
```

Replace the values with your speaker's actual details from Step 4.1.

---

## Part 5: Start SoundCork

### 5.1 Run the container

```bash
docker run -d \
  --name soundcork \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /soundcork/data:/soundcork/data \
  -e base_url=http://192.168.1.229:8000 \
  -e data_dir=/soundcork/data \
  -e MGMT_PASSWORD=YourStrongPasswordHere \
  soundcork-local:latest
```

Replace:
- `192.168.1.229` with your Docker server's IP
- `YourStrongPasswordHere` with a password of your choice

### 5.2 Verify it's running

```bash
docker ps
curl http://localhost:8000
```

A healthy response looks like:
```json
{"Bose":"Can't Brick Us"}
```

### 5.3 Check the logs

```bash
docker logs soundcork --tail 20
```

Look for:
```
Speaker allowlist refreshed: 1 IPs
Application startup complete.
```

If you see `Speaker allowlist refreshed: 0 IPs`, the DeviceInfo.xml is missing or in the wrong location. Double-check your folder structure from Step 4.2.

---

## Part 6: Redirect the Speaker to SoundCork

By default the speaker tries to connect to Bose's (now dead) cloud servers. You need to change the speaker's configuration to point to your SoundCork server instead.

### 6.1 Save the SoundCork config template

From your Docker server, create the template config file that you will push to all speakers:

```bash
cat > /soundcork/docker/SoundTouchSdkPrivateCfg.xml << 'EOF'
<?xml version="1.0" encoding="utf-8"?>
<SoundTouchSdkPrivateCfg>
  <margeServerUrl>http://192.168.1.229:8000</margeServerUrl>
  <statsServerUrl>http://192.168.1.229:8000</statsServerUrl>
  <swUpdateUrl>http://192.168.1.229:8000</swUpdateUrl>
  <usePandoraProductionServer>true</usePandoraProductionServer>
  <isZeroconfEnabled>true</isZeroconfEnabled>
  <saveMargeCustomerReport>false</saveMargeCustomerReport>
  <bmxRegistryUrl>http://192.168.1.229:8000/bmx/registry/v1/services</bmxRegistryUrl>
</SoundTouchSdkPrivateCfg>
EOF
```

Replace `192.168.1.229` with your SoundCork server's IP.

> **Save this file.** Every additional speaker gets this same config pushed to it. You will use it repeatedly.

### 6.2 Push the config to the speaker

First SSH into the speaker and make the filesystem writable:

```bash
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa root@192.168.1.228
rw
exit
```

Then push the config file from your Docker server:

```bash
cat /soundcork/docker/SoundTouchSdkPrivateCfg.xml | \
  ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@192.168.1.228 \
  "cat > /opt/Bose/etc/SoundTouchSdkPrivateCfg.xml"
```

Verify it was written correctly:

```bash
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@192.168.1.228 \
  "cat /opt/Bose/etc/SoundTouchSdkPrivateCfg.xml"
```

You should see all URLs pointing to your SoundCork server IP.

### 6.3 Reboot the speaker

```bash
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@192.168.1.228 "reboot"
```

Wait 45-60 seconds for the speaker to come back up.

### 6.4 Verify the speaker is connected

Watch the SoundCork logs while the speaker boots:
```bash
docker logs soundcork -f --tail 5
```

You should see the speaker making requests like:
```
192.168.1.228:XXXXX - "GET / HTTP/1.1" 200
192.168.1.228:XXXXX - "GET /streaming/sourceproviders HTTP/1.1" 200
192.168.1.228:XXXXX - "GET /streaming/account/4365315/full HTTP/1.1" 200
```

This confirms the speaker is now talking to SoundCork instead of Bose's servers.

### 6.5 Test TuneIn playback

Open a browser and go to `http://192.168.1.229:8000/webui/` — log in with the `MGMT_PASSWORD` you set in Step 5.1. You should see your speaker listed. Click on it and try playing a preset.

---

## Part 7: Install the Home Assistant Integration

### 7.1 Copy the custom integration

From your Home Assistant terminal or via SSH to the HA server:

```bash
# Copy integration files to HA config directory
# Copy from the cloned repo (ha-integration folder)
cp -r /soundcork/ha-integration/custom_components/soundcork \
  /config/custom_components/
```

Or manually copy the `custom_components/soundcork/` folder from this repo to `/config/custom_components/soundcork/` on your HA server.

### 7.2 Restart Home Assistant

In HA go to **Settings → System → Restart** or from terminal:
```bash
ha core restart
```

### 7.3 Add the integration

1. Go to **Settings → Devices & Services → Add Integration**
2. Search for **SoundCork**
3. Enter your SoundCork URL: `http://192.168.1.229:8000`
4. Complete the setup

A `media_player` entity will be created for each speaker registered in `webui_speakers.json`.

---

## Part 8: Install the Lovelace Card

### 8.1 Copy the card file to HA

```bash
cp /soundcork/lovelace-card/soundcork-preset-editor.js \
  /config/www/soundcork-preset-editor.js
```

### 8.2 Register as a dashboard resource

1. Go to **Settings → Dashboards → three-dot menu → Resources**
2. Click **Add Resource**
3. URL: `/local/soundcork-preset-editor.js`
4. Type: **JavaScript Module**
5. Save and hard refresh your browser (`Ctrl+Shift+R`)

### 8.3 Create your dashboard

Create a new dashboard and paste the example from `docs/dashboard-example.yaml` in this repo, replacing `YOUR_SOUNDCORK_IP` with your server's IP and the `media_player.SPEAKER_NAME` entries with your actual HA entity IDs.

Find your entity IDs under **Settings → Devices & Services → SoundCork**.

---

## Part 9: Adding More Speakers

Once your first speaker is working, each additional speaker follows a streamlined 4-step process. You only need the speaker's IP address.

**From your Docker server, run these 4 commands** (replace `192.168.1.41` and values accordingly):

```bash
SPEAKER_IP="192.168.1.41"

# Step 1: Get device info and create folder
INFO=$(curl -s http://$SPEAKER_IP:8090/info)
DEVICE_ID=$(echo $INFO | grep -o 'deviceID="[^"]*"' | cut -d'"' -f2)
ACCOUNT_ID=$(echo $INFO | grep -o 'margeAccountUUID>[^<]*' | cut -d'>' -f2)
mkdir -p /soundcork/data/$ACCOUNT_ID/devices/$DEVICE_ID

# Step 2: Save DeviceInfo.xml
echo $INFO > /soundcork/data/$ACCOUNT_ID/devices/$DEVICE_ID/DeviceInfo.xml

# Step 3: Make filesystem writable then push SoundCork config
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@$SPEAKER_IP "rw" 2>/dev/null || true

cat /soundcork/docker/SoundTouchSdkPrivateCfg.xml | \
  ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@$SPEAKER_IP \
  "cat > /opt/Bose/etc/SoundTouchSdkPrivateCfg.xml"

# Step 4: Reboot the speaker
ssh -oHostKeyAlgorithms=ssh-rsa -oPubkeyAcceptedKeyTypes=ssh-rsa \
  root@$SPEAKER_IP "reboot"
```

Then add the speaker to `webui_speakers.json` and restart SoundCork:

```bash
# Edit webui_speakers.json to add the new speaker entry
# Then apply permissions and restart
chown -R 1000:1000 /soundcork/data
docker restart soundcork
```

> **Note on Sources.xml:** If this is your first speaker on a given Bose account, you need to also collect Sources.xml (Step 4.4). Additional speakers sharing the same account ID do NOT need a new Sources.xml — the account-level file already exists.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Speaker allowlist refreshed: 0 IPs` | DeviceInfo.xml missing or wrong path | Check `/soundcork/data/<accountId>/devices/<deviceId>/DeviceInfo.xml` exists |
| Speaker not appearing in logs after reboot | Config not pushed correctly | Re-run Step 6.2, verify with `ssh root@<ip> cat /opt/Bose/etc/SoundTouchSdkPrivateCfg.xml` |
| Files start with `??` instead of `<?xml` | Encoding issue from Windows tools | Re-fetch using Linux `curl` or `ssh` commands |
| TuneIn works but podcasts don't play | Using original SoundCork image | Ensure you built from this repo's Dockerfile, not `ghcr.io/timvw/soundcork:main` directly |
| HA integration not found | Custom component not in right directory | Verify `/config/custom_components/soundcork/manifest.json` exists, restart HA |
| Lovelace card not loading | Resource not registered or cache | Register `/local/soundcork-preset-editor.js` as resource, hard refresh (`Ctrl+Shift+R`) |
| `MGMT_PASSWORD` error on startup | Default password not changed | Add `-e MGMT_PASSWORD=yourpassword` to the docker run command |

---

## Data Directory Reference

```
/soundcork/data/
├── <accountId>/                    ← from margeAccountUUID in speaker info
│   ├── devices/
│   │   └── <deviceId>/            ← from deviceID in speaker info
│   │       └── DeviceInfo.xml     ← fetched from http://<ip>:8090/info
│   ├── Presets.xml                ← fetched from http://<ip>:8090/presets
│   ├── Recents.xml                ← fetched from http://<ip>:8090/recents
│   └── Sources.xml                ← fetched via SSH from speaker filesystem
└── webui_speakers.json            ← manually created, lists all speakers
```

All files under `/soundcork/data` must be owned by user ID 1000:
```bash
chown -R 1000:1000 /soundcork/data
```
EOF
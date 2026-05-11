"""Constants for the SoundCork integration."""

DOMAIN = "soundcork"

CONF_BASE_URL = "base_url"

# Polling interval in seconds
SCAN_INTERVAL_SECONDS = 30

# Speaker data keys
ATTR_IP_ADDRESS = "ip_address"
ATTR_DEVICE_ID = "device_id"
ATTR_SPEAKER_NAME = "speaker_name"
ATTR_SPEAKER_TYPE = "speaker_type"

# Service names
SERVICE_PLAY_PRESET = "play_preset"
SERVICE_STORE_PRESET_TUNEIN = "store_preset_tunein"
SERVICE_STORE_PRESET_RADIO = "store_preset_radio"

# Service field names
FIELD_PRESET = "preset"
FIELD_STATION_ID = "station_id"
FIELD_STREAM_URL = "stream_url"
FIELD_NAME = "name"
FIELD_ART_URL = "art_url"

# SoundCork source types
SOURCE_TUNEIN = "TUNEIN"
SOURCE_LOCAL_INTERNET_RADIO = "LOCAL_INTERNET_RADIO"
SOURCE_SPOTIFY = "SPOTIFY"
SOURCE_PANDORA = "PANDORA"
SOURCE_AMAZON = "AMAZON"
SOURCE_AUX = "AUX"
SOURCE_STANDBY = "STANDBY"